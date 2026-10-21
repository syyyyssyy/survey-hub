'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { MongoClient, ObjectId } = require('mongodb');
const { createApp } = require('../src/app');

let client;
let db;
let app;
let owner;

const answer = (qid, type, value) => ({ qid, type, value });

async function createPublished(title, questions) {
  const created = await owner.post('/api/surveys').send({ title, allowMultiple: true });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  for (const question of questions) {
    assert.equal((await owner.post(`/api/surveys/${id}/questions`).send(question)).status, 201);
  }
  const published = await owner.post(`/api/surveys/${id}/publish`);
  assert.equal(published.status, 201);
  return { id, publicId: created.body.data.publicId, versionId: published.body.data.versionId };
}

async function next(survey, currentQid, answers) {
  return owner.post(`/api/public/surveys/${survey.publicId}/next`).send({
    versionId: survey.versionId, currentQid, answers
  });
}

async function submit(survey, answers, key) {
  return owner.post(`/api/public/surveys/${survey.publicId}/submit`).send({
    versionId: survey.versionId, clientSubmissionId: key, anonymous: false, answers
  });
}

test.before(async () => {
  client = new MongoClient(process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017', {
    serverSelectionTimeoutMS: 3000
  });
  await client.connect();
  db = client.db(`survey_matrix_test_${new ObjectId()}`);
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('surveys').createIndex({ publicId: 1 }, { unique: true });
  await db.collection('survey_versions').createIndex({ surveyId: 1, version: 1 }, { unique: true });
  await db.collection('responses').createIndex(
    { surveyId: 1, respondentKey: 1, clientSubmissionId: 1 }, { unique: true }
  );
  await db.collection('responses').createIndex(
    { dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
  );
  app = createApp(db, { sessionSecret: 'matrix-test-secret-with-at-least-32-characters' });
  owner = request.agent(app);
  assert.equal((await owner.post('/api/auth/register').send({
    username: 'matrix-owner', password: 'good-password'
  })).status, 201);
});

test.after(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

test('API interprets single, multi, number and default-order jumps', async () => {
  const survey = await createPublished('Jump matrix', [
    { qid: 'start', type: 'single', title: 'Start', required: true,
      options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }, { id: 'C', text: 'C' }],
      jumpRules: [
        { id: 'a', when: { optionId: 'A' }, targetQid: 'age' },
        { id: 'b', when: { optionId: 'B' }, targetQid: 'select' }
      ] },
    { qid: 'ordinary', type: 'text', title: 'Ordinary', required: true },
    { qid: 'select', type: 'multi', title: 'Select', required: true,
      options: [{ id: 'X', text: 'X' }, { id: 'Y', text: 'Y' }],
      jumpRules: [{ id: 'x', when: { containsOptionId: 'X' }, targetQid: 'age' }] },
    { qid: 'middle', type: 'text', title: 'Middle', required: true },
    { qid: 'age', type: 'number', title: 'Age', required: true,
      jumpRules: [{ id: 'adult', when: { op: 'gte', value: 18 }, targetQid: 'adult' }] },
    { qid: 'minor', type: 'text', title: 'Minor', required: true },
    { qid: 'adult', type: 'text', title: 'Adult', required: true }
  ]);
  const startA = answer('start', 'single', 'A');
  const startB = answer('start', 'single', 'B');
  const startC = answer('start', 'single', 'C');
  assert.equal((await next(survey, 'start', [startA])).body.data.nextQid, 'age');
  assert.equal((await next(survey, 'start', [startB])).body.data.nextQid, 'select');
  assert.equal((await next(survey, 'start', [startC])).body.data.nextQid, 'ordinary');
  const chosen = answer('select', 'multi', ['X', 'Y']);
  assert.equal((await next(survey, 'select', [startB, chosen])).body.data.nextQid, 'age');
  const adult = answer('age', 'number', 18);
  assert.equal((await next(survey, 'age', [startA, adult])).body.data.nextQid, 'adult');
  assert.equal((await next(survey, 'age', [startA, answer('age', 'number', 17)])).body.data.nextQid, 'minor');
  assert.equal((await next(survey, 'select', [startB, answer('select', 'multi', ['Y'])])).body.data.nextQid, 'middle');
  const valid = await submit(survey, [startA, adult, answer('adult', 'text', 'ok')], 'jump-valid');
  assert.equal(valid.status, 201);
  assert.deepEqual(valid.body.data.path, ['start', 'age', 'adult']);
  assert.equal((await submit(survey, [startA, adult, answer('minor', 'text', 'outside'),
    answer('adult', 'text', 'ok')], 'jump-outside')).body.code, 'JUMP_PATH_MISMATCH');
  assert.equal((await submit(survey, [answer('start', 'single', 'unknown')], 'unknown-option')).body.code,
    'VALIDATION_ERROR');
  assert.equal(await db.collection('responses').countDocuments({ surveyId: new ObjectId(survey.id) }), 1);
});

test('API rejects missing, selection-count, text-length and numeric-range errors', async () => {
  const survey = await createPublished('Validation matrix', [
    { qid: 'choices', type: 'multi', title: 'Choices', required: true,
      options: ['A', 'B', 'C'].map((id) => ({ id, text: id })),
      validation: { minSelect: 2, maxSelect: 2 } },
    { qid: 'memo', type: 'text', title: 'Memo', required: true,
      validation: { minLength: 2, maxLength: 4 } },
    { qid: 'amount', type: 'number', title: 'Amount', required: true,
      validation: { min: 1, max: 10, integer: true } }
  ]);
  const valid = [answer('choices', 'multi', ['A', 'B']), answer('memo', 'text', 'good'),
    answer('amount', 'number', 5)];
  const invalid = [
    [],
    [answer('choices', 'multi', ['A']), ...valid.slice(1)],
    [answer('choices', 'multi', ['A', 'B', 'C']), ...valid.slice(1)],
    [valid[0], answer('memo', 'text', 'x'), valid[2]],
    [valid[0], answer('memo', 'text', 'longer'), valid[2]],
    [valid[0], valid[1], answer('amount', 'number', 0)],
    [valid[0], valid[1], answer('amount', 'number', 11)],
    [valid[0], valid[1], answer('amount', 'number', 1.5)],
    [valid[0], valid[1], answer('amount', 'number', null)],
    [valid[0], valid[1], answer('amount', 'number', '5')]
  ];
  for (const [index, answers] of invalid.entries()) {
    assert.equal((await submit(survey, answers, `invalid-${index}`)).body.code,
      'VALIDATION_ERROR', `case ${index}`);
  }
  assert.equal(await db.collection('responses').countDocuments({ surveyId: new ObjectId(survey.id) }), 0);
  const lower = await submit(survey, [answer('choices', 'multi', ['A', 'B']),
    answer('memo', 'text', 'ab'), answer('amount', 'number', 1)], 'invalid-0');
  const upper = await submit(survey, [answer('choices', 'multi', ['B', 'C']),
    answer('memo', 'text', 'abcd'), answer('amount', 'number', 10)], 'upper-boundaries');
  assert.equal(lower.status, 201);
  assert.equal(upper.status, 201);
  assert.equal(await db.collection('responses').countDocuments({ surveyId: new ObjectId(survey.id) }), 2);
  const exact = await createPublished('Exact selection', [{
    qid: 'exact', type: 'multi', title: 'Exact', required: true,
    options: ['A', 'B'].map((id) => ({ id, text: id })), validation: { exactSelect: 2 }
  }]);
  assert.equal((await submit(exact, [answer('exact', 'multi', ['A'])], 'exact-bad')).body.code,
    'VALIDATION_ERROR');
  assert.equal((await submit(exact, [answer('exact', 'multi', ['A', 'B'])], 'exact-good')).status, 201);
});

test('closed surveys reject new submissions and public reads', async () => {
  const survey = await createPublished('Closed survey', [
    { qid: 'note', type: 'text', title: 'Note', required: true }
  ]);
  await db.collection('surveys').updateOne({ _id: new ObjectId(survey.id) },
    { $set: { status: 'closed' } });
  assert.equal((await owner.get(`/api/public/surveys/${survey.publicId}`)).body.code,
    'SURVEY_CLOSED');
  assert.equal((await submit(survey, [answer('note', 'text', 'value')], 'closed')).body.code,
    'SURVEY_CLOSED');
});

test('combined multi-choice and numeric interval rules are validated and executed through API', async () => {
  const survey = await createPublished('Combined rules', [
    { qid: 'pick', type: 'multi', title: 'Pick', required: true,
      options: ['A', 'B', 'C'].map((id) => ({ id, text: id })),
      jumpRules: [{ id: 'both', when: { containsAllOptionIds: ['A', 'B'] }, targetQid: 'age' }] },
    { qid: 'ordinary', type: 'text', title: 'Ordinary', required: false },
    { qid: 'age', type: 'number', title: 'Age', required: true,
      jumpRules: [{ id: 'range', when: { op: 'between', min: 18, max: 60 }, targetQid: 'inside' }] },
    { qid: 'outside', type: 'text', title: 'Outside', required: false },
    { qid: 'inside', type: 'text', title: 'Inside', required: false }
  ]);
  const chosen = answer('pick', 'multi', ['A', 'B']);
  assert.equal((await next(survey, 'pick', [chosen])).body.data.nextQid, 'age');
  assert.equal((await next(survey, 'pick', [answer('pick', 'multi', ['A'])])).body.data.nextQid, 'ordinary');
  assert.equal((await next(survey, 'age', [chosen, answer('age', 'number', 18)])).body.data.nextQid, 'inside');
  assert.equal((await next(survey, 'age', [chosen, answer('age', 'number', 61)])).body.data.nextQid, 'outside');
  assert.equal((await submit(survey, [chosen, answer('age', 'number', 18)], 'combined')).status, 201);
});

test('multi exclusion rule publishes, routes optional answers and rejects invalid options', async () => {
  const survey = await createPublished('Excluded choices', [
    { qid: 'pick', type: 'multi', title: 'Pick', required: false,
      options: ['A', 'B', 'C'].map((id) => ({ id, text: id })),
      jumpRules: [{ id: 'withoutAB', when: { excludesOptionIds: ['A', 'B'] }, targetQid: 'other' }] },
    { qid: 'ordinary', type: 'text', title: 'Ordinary', required: false },
    { qid: 'other', type: 'text', title: 'Other', required: false }
  ]);
  for (const selected of [['C'], [], undefined]) {
    const answers = selected === undefined ? [] : [answer('pick', 'multi', selected)];
    const result = await next(survey, 'pick', answers);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.nextQid, 'other');
  }
  for (const selected of [['A'], ['B'], ['A', 'C']]) {
    const result = await next(survey, 'pick', [answer('pick', 'multi', selected)]);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.nextQid, 'ordinary');
  }
  const submitted = await submit(survey, [answer('pick', 'multi', ['C'])], 'exclude-valid');
  assert.equal(submitted.status, 201);
  assert.deepEqual(submitted.body.data.path, ['pick', 'other']);
  assert.equal((await submit(survey, [answer('pick', 'multi', ['C']),
    answer('ordinary', 'text', 'outside')], 'exclude-outside')).body.code, 'JUMP_PATH_MISMATCH');
  assert.equal(await db.collection('responses').countDocuments({ surveyId: new ObjectId(survey.id) }), 1);

  const created = await owner.post('/api/surveys').send({ title: 'Invalid exclusion' });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  const base = { qid: '1', type: 'multi', title: 'Pick', required: false,
    options: [{ id: 'A', text: 'A' }] };
  for (const ids of [[], ['X'], ['A', 'A']]) {
    const invalid = await owner.post(`/api/surveys/${id}/questions`).send({
      ...base, jumpRules: [{ id: 'r1', when: { excludesOptionIds: ids }, targetQid: '2' }]
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'VALIDATION_ERROR');
  }
  assert.equal((await db.collection('surveys').findOne({ _id: new ObjectId(id) })).draftQuestions.length, 0);
});

test('question editor saves an exclusion rule through PUT questions', async () => {
  const created = await owner.post('/api/surveys').send({ title: 'Editor exclusion rule' });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  const questions = [
    { qid: '1', type: 'multi', title: 'Pick', required: false,
      options: ['A', 'B', 'C'].map((optionId) => ({ id: optionId, text: optionId })),
      validation: {}, jumpRules: [{ id: 'r1', when: { excludesOptionIds: ['A', 'B'] }, targetQid: '2' }] },
    { qid: '2', type: 'text', title: 'Follow up', required: false,
      options: [], validation: {}, jumpRules: [] }
  ];
  const saved = await owner.put(`/api/surveys/${id}/questions`).send(questions);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data, questions);
  const stored = await db.collection('surveys').findOne({ _id: new ObjectId(id) });
  assert.deepEqual(stored.draftQuestions, questions);
  assert.equal((await owner.post(`/api/surveys/${id}/publish`)).status, 201);
});
