'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { MongoClient, ObjectId } = require('mongodb');
const { createApp } = require('../src/app');

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
let client;
let db;
let app;
let owner;
let outsider;
let surveyId;
let firstVersionId;
let secondVersionId;

const questions = [
  { qid: 'choice', type: 'single', title: 'Choice', required: true,
    options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }, { id: 'C', text: 'C' }] },
  { qid: 'tags', type: 'multi', title: 'Tags', required: false,
    options: [{ id: 'X', text: 'X' }, { id: 'Y', text: 'Y' }] },
  { qid: 'comment', type: 'text', title: 'Comment', required: false },
  { qid: 'score', type: 'number', title: 'Score', required: false }
];

const answer = (qid, type, value) => ({ qid, type, value });
const response = (versionId, index, answers) => ({
  surveyId,
  versionId,
  respondentId: null,
  respondentKey: `respondent-${versionId}-${index}`,
  dedupeKey: null,
  anonymous: true,
  clientSubmissionId: `submission-${versionId}-${index}`,
  answers,
  path: questions.map((question) => question.qid),
  submittedAt: new Date(Date.UTC(2026, 0, 1, 0, index))
});

test.before(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(`survey_statistics_test_${new ObjectId().toString()}`);
  app = createApp(db, { sessionSecret: 'test-secret-with-at-least-32-characters' });
  owner = request.agent(app);
  outsider = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'statistics-owner', password: 'good-password' });
  await outsider.post('/api/auth/register').send({ username: 'statistics-outsider', password: 'good-password' });
  const created = await owner.post('/api/surveys').send({ title: 'Statistics' });
  surveyId = new ObjectId(created.body.data._id);
  for (const question of questions) {
    const added = await owner.post(`/api/surveys/${surveyId}/questions`).send(question);
    assert.equal(added.status, 201);
  }
  const published = await owner.post(`/api/surveys/${surveyId}/publish`);
  assert.equal(published.status, 201);
  firstVersionId = new ObjectId(published.body.data.versionId);
  await db.collection('responses').insertMany([
    response(firstVersionId, 1, [answer('choice', 'single', 'A'), answer('tags', 'multi', ['X', 'Y']), answer('comment', 'text', 'alpha'), answer('score', 'number', 10)]),
    response(firstVersionId, 2, [answer('choice', 'single', 'A'), answer('tags', 'multi', ['Y']), answer('comment', 'text', 'beta'), answer('score', 'number', 20)]),
    response(firstVersionId, 3, [answer('choice', 'single', 'B'), answer('tags', 'multi', [])])
  ]);
});

test.after(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

test('whole and single-question statistics use fixed response data', async () => {
  const base = `/api/surveys/${surveyId}/statistics`;
  const whole = await owner.get(base);
  assert.equal(whole.status, 200);
  assert.equal(whole.body.data.versionId, firstVersionId.toString());
  assert.equal(whole.body.data.totalResponses, 3);
  assert.deepEqual(whole.body.data.questions, [
    { qid: 'choice', type: 'single', title: 'Choice', count: 3, counts: [
      { optionId: 'A', text: 'A', count: 2 }, { optionId: 'B', text: 'B', count: 1 }, { optionId: 'C', text: 'C', count: 0 }
    ] },
    { qid: 'tags', type: 'multi', title: 'Tags', counts: [
      { optionId: 'X', text: 'X', count: 1 }, { optionId: 'Y', text: 'Y', count: 2 }
    ] },
    { qid: 'comment', type: 'text', title: 'Comment', count: 2, values: ['alpha', 'beta'] },
    { qid: 'score', type: 'number', title: 'Score', count: 2, avg: 15, min: 10, max: 20, values: [10, 20] }
  ]);
  const single = await owner.get(`${base}/tags`);
  assert.equal(single.status, 200);
  assert.equal(single.body.data.totalResponses, 3);
  assert.deepEqual(single.body.data.question, whole.body.data.questions[1]);
  assert.equal(whole.body.data.questions[0].count, 3);
  const multiRespondents = await db.collection('responses').countDocuments({
    surveyId, versionId: firstVersionId,
    answers: { $elemMatch: { qid: 'tags', 'value.0': { $exists: true } } }
  });
  assert.equal(multiRespondents, 2);
  assert.equal(whole.body.data.totalResponses, 3);
  assert.equal(whole.body.data.questions[1].counts.reduce((sum, item) => sum + item.count, 0), 3);
  assert.equal(whole.body.data.questions[1].counts.filter((item) => item.count > 0).length, 2);
  for (const question of whole.body.data.questions) {
    const detail = await owner.get(`${base}/${question.qid}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.totalResponses, 3);
    assert.deepEqual(detail.body.data.question, question);
  }
  assert.doesNotMatch(JSON.stringify(whole.body.data), /respondentId|respondentKey|clientSubmissionId|dedupeKey/);
});

test('a draft with no questions has no published statistics', async () => {
  const created = await owner.post('/api/surveys').send({ title: 'Unpublished empty survey' });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  const stats = await owner.get(`/api/surveys/${id}/statistics`);
  assert.equal(stats.status, 404);
  assert.equal(stats.body.code, 'NOT_FOUND');
  assert.equal(await db.collection('survey_versions').countDocuments({ surveyId: new ObjectId(id) }), 0);
});

test('an older version stays unchanged after new-version responses arrive', async () => {
  const base = `/api/surveys/${surveyId}/statistics`;
  const oldBefore = (await owner.get(`${base}?versionId=${firstVersionId}`)).body.data;
  const secondQuestions = [
    { qid: 'choice', type: 'single', title: 'New choice', required: true,
      options: [{ id: 'D', text: 'D' }, { id: 'E', text: 'E' }] },
    { qid: 'score', type: 'number', title: 'New score', required: true }
  ];
  const secondVersion = await db.collection('survey_versions').insertOne({
    surveyId, version: 2, questions: secondQuestions, publishedAt: new Date(), publishedBy: surveyId
  });
  secondVersionId = secondVersion.insertedId;
  await db.collection('surveys').updateOne({ _id: surveyId }, { $set: { publishedVersionId: secondVersionId } });
  await db.collection('responses').insertMany([
    response(secondVersionId, 4, [answer('choice', 'single', 'D'), answer('score', 'number', 100)]),
    response(secondVersionId, 5, [answer('choice', 'single', 'E'), answer('score', 'number', 200)])
  ]);
  const current = (await owner.get(base)).body.data;
  assert.equal(current.versionId, secondVersionId.toString());
  assert.equal(current.totalResponses, 2);
  assert.deepEqual(current.questions, [
    { qid: 'choice', type: 'single', title: 'New choice', count: 2, counts: [
      { optionId: 'D', text: 'D', count: 1 }, { optionId: 'E', text: 'E', count: 1 }
    ] },
    { qid: 'score', type: 'number', title: 'New score', count: 2, avg: 150, min: 100, max: 200, values: [100, 200] }
  ]);
  const oldAfter = (await owner.get(`${base}?versionId=${firstVersionId}`)).body.data;
  assert.deepEqual(oldAfter, oldBefore);
  assert.deepEqual((await owner.get(`${base}/comment?versionId=${firstVersionId}`)).body.data.question,
    oldBefore.questions[2]);
});

test('statistics require ownership and a version belonging to the survey', async () => {
  const base = `/api/surveys/${surveyId}/statistics`;
  assert.equal((await request(app).get(base)).body.code, 'LOGIN_REQUIRED');
  assert.equal((await outsider.get(base)).body.code, 'NOT_OWNER');
  assert.equal((await outsider.get(`${base}/choice`)).body.code, 'NOT_OWNER');
  assert.equal((await owner.get(`${base}?versionId=bad`)).body.code, 'VALIDATION_ERROR');
  assert.equal((await owner.get(`${base}?versionId=${new ObjectId()}`)).body.code, 'NOT_FOUND');
  assert.equal((await owner.get(`${base}/unknown?versionId=${firstVersionId}`)).body.code, 'NOT_FOUND');
  const foreign = await db.collection('survey_versions').insertOne({
    surveyId: new ObjectId(), version: 1, questions: [], publishedAt: new Date(), publishedBy: surveyId
  });
  assert.equal((await owner.get(`${base}?versionId=${foreign.insertedId}`)).body.code, 'NOT_FOUND');
});

test('a published version with no responses returns zero counts and null numeric metrics', async () => {
  const created = await owner.post('/api/surveys').send({ title: 'Empty statistics' });
  const id = created.body.data._id;
  for (const question of questions) {
    assert.equal((await owner.post(`/api/surveys/${id}/questions`).send(question)).status, 201);
  }
  assert.equal((await owner.post(`/api/surveys/${id}/publish`)).status, 201);
  const result = (await owner.get(`/api/surveys/${id}/statistics`)).body.data;
  assert.equal(result.totalResponses, 0);
  assert.deepEqual(result.questions[0].counts.map((option) => option.count), [0, 0, 0]);
  assert.deepEqual(result.questions[1].counts.map((option) => option.count), [0, 0]);
  assert.deepEqual(result.questions[2].values, []);
  assert.equal(result.questions[0].count, 0);
  assert.deepEqual(result.questions[3].values, []);
  assert.deepEqual({ count: result.questions[3].count, avg: result.questions[3].avg,
    min: result.questions[3].min, max: result.questions[3].max },
  { count: 0, avg: null, min: null, max: null });
});

test('single-question answer count excludes skipped optional answers', async () => {
  const created = (await owner.post('/api/surveys').send({ title: 'Skipped choice' })).body.data;
  const base = `/api/surveys/${created._id}`;
  await owner.post(`${base}/questions`).send({ qid: '1', type: 'single', title: 'Optional', required: false,
    options: [{ id: 'A', text: 'Yes' }] });
  const versionId = (await owner.post(`${base}/publish`)).body.data.versionId;
  assert.equal((await owner.post(`/api/public/surveys/${created.publicId}/submit`).send({
    versionId, clientSubmissionId: 'skipped-choice', anonymous: false, answers: []
  })).status, 201);
  const statistics = (await owner.get(`${base}/statistics/1`)).body.data;
  assert.equal(statistics.totalResponses, 1);
  assert.equal(statistics.question.count, 0);
  assert.deepEqual(statistics.question.counts, [{ optionId: 'A', text: 'Yes', count: 0 }]);
});
