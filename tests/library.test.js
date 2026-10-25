'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('mongodb');
const request = require('supertest');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createApp } = require('../src/app');

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
let client;
let db;
let app;
const user = async (name) => {
  const agent = request.agent(app);
  const result = await agent.post('/api/auth/register').send({ username: name, password: 'test-password' });
  assert.equal(result.status, 201);
  return agent;
};
const createSurvey = async (agent, title) => {
  const result = await agent.post('/api/surveys').send({ title });
  assert.equal(result.status, 201);
  return result.body.data;
};
const choice = (title) => ({ type: 'single', title, required: true,
  options: [{ id: 'A', text: 'Yes' }, { id: 'B', text: 'No' }] });

test.before(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(`survey_library_test_${new ObjectId()}`);
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('surveys').createIndex({ publicId: 1 }, { unique: true });
  await db.collection('survey_versions').createIndex({ surveyId: 1, version: 1 }, { unique: true });
  await db.collection('question_versions').createIndex({ questionId: 1, version: 1 }, { unique: true });
  app = createApp(db, { sessionSecret: 'library-test-secret-with-at-least-32-characters' });
});
test.after(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

test('banks save survey questions and insert an explicitly chosen version without old jump targets', async () => {
  const page = await request(app).get('/');
  assert.match(page.text, /id="library-view"/);
  assert.match(page.text, /id="choose-library"/);
  const owner = await user('bank-owner');
  const bank = (await owner.post('/api/question-banks').send({ name: 'General' })).body.data;
  assert.equal(bank.name, 'General');
  assert.equal((await owner.get('/api/question-banks')).body.data[0]._id, bank._id);
  assert.equal((await owner.patch(`/api/question-banks/${bank._id}`).send({ name: 'Renamed' })).body.data.name, 'Renamed');
  const source = await createSurvey(owner, 'Source');
  const original = { qid: '1', ...choice('Original'), jumpRules: [{ id: 'r1', when: { optionId: 'A' }, targetQid: '2' }] };
  assert.equal((await owner.post(`/api/surveys/${source._id}/questions`).send(original)).status, 201);
  const saved = await owner.post(`/api/question-banks/${bank._id}/questions`).send({ surveyId: source._id, qid: '1' });
  assert.equal(saved.status, 201);
  const item = saved.body.data;
  assert.equal(item.currentVersion.content.title, 'Original');
  assert.equal(item.currentVersion.content.jumpRules, undefined);
  const destination = await createSurvey(owner, 'Destination');
  const inserted = await owner.post(`/api/surveys/${destination._id}/questions/from-library`)
    .send({ questionVersionId: item.currentVersionId, qid: '1' });
  assert.equal(inserted.status, 201);
  assert.deepEqual(inserted.body.data.jumpRules, []);
  assert.equal(inserted.body.data.libraryQuestionId, item._id);
  assert.equal((await db.collection('surveys').findOne({ _id: new ObjectId(destination._id) }))
    .draftQuestions[0].questionVersionId, item.currentVersionId);
  assert.equal((await owner.delete(`/api/question-banks/${bank._id}`)).status, 409);
});

test('share link imports independent copies for multiple users and keeps private access', async () => {
  const owner = await user('share-owner');
  const receiver = await user('share-receiver');
  const outsider = await user('share-outsider');
  const bank = (await owner.post('/api/question-banks').send({ name: 'Share' })).body.data;
  const item = (await owner.post(`/api/question-banks/${bank._id}/questions`)
    .send({ question: choice('Shared') })).body.data;
  const draft = await createSurvey(receiver, 'Receiver survey');
  const insertUrl = `/api/surveys/${draft._id}/questions/from-library`;
  const payload = { questionVersionId: item.currentVersionId, qid: '1' };
  assert.equal((await receiver.post(insertUrl).send(payload)).status, 403);
  assert.equal((await outsider.get(`/api/library-questions/${item._id}/versions`)).status, 403);
  const link = await owner.post(`/api/library-questions/${item._id}/share-link`);
  assert.equal(link.status, 200);
  const token = link.body.data.token;
  const imported = await receiver.post('/api/library-questions/import').send({ token });
  const secondImport = await outsider.post('/api/library-questions/import').send({ token });
  assert.equal(imported.status, 201);
  assert.equal(secondImport.status, 201);
  assert.notEqual(imported.body.data._id, item._id);
  assert.notEqual(secondImport.body.data._id, imported.body.data._id);
  assert.equal(imported.body.data.currentVersion.content.title, 'Shared');
  assert.equal((await receiver.post(insertUrl).send({ questionVersionId: imported.body.data.currentVersionId, qid: '1' })).status, 201);
  assert.equal((await receiver.post(`/api/library-questions/${item._id}/versions`)
    .send({ question: choice('Unauthorized') })).status, 403);
  assert.equal((await receiver.get(`/api/library-questions/${item._id}/statistics`)).status, 403);
  assert.equal((await outsider.post(insertUrl).send(payload)).status, 403);
  const changed = await owner.post(`/api/library-questions/${item._id}/versions`)
    .send({ question: choice('Owner changed') });
  assert.equal(changed.status, 201);
  assert.equal((await receiver.get(`/api/library-questions/${imported.body.data._id}/versions`))
    .body.data[0].content.title, 'Shared');
  assert.equal((await outsider.get(`/api/library-questions/${secondImport.body.data._id}/versions`))
    .body.data[0].content.title, 'Shared');
  assert.equal((await owner.delete(`/api/library-questions/${item._id}/share-link`)).status, 200);
  assert.equal((await receiver.post('/api/library-questions/import').send({ token })).status, 404);
});

test('selecting an old version changes the default while existing surveys keep their snapshots', async () => {
  const owner = await user('version-owner');
  const respondent = await user('version-respondent');
  const bank = (await owner.post('/api/question-banks').send({ name: 'Versions' })).body.data;
  const item = (await owner.post(`/api/question-banks/${bank._id}/questions`)
    .send({ question: choice('First') })).body.data;
  const first = await createSurvey(owner, 'Uses first');
  await owner.post(`/api/surveys/${first._id}/questions/from-library`)
    .send({ questionVersionId: item.currentVersionId, qid: '1' });
  const firstPublish = await owner.post(`/api/surveys/${first._id}/publish`);
  assert.equal(firstPublish.status, 201);
  const originalAnswer = await respondent.post(`/api/public/surveys/${first.publicId}/submit`).send({
    versionId: firstPublish.body.data.versionId, clientSubmissionId: 'before-library-edit',
    anonymous: false, answers: [{ qid: '1', type: 'single', value: 'A' }]
  });
  assert.equal(originalAnswer.status, 201);
  const secondVersion = (await owner.post(`/api/library-questions/${item._id}/versions`)
    .send({ question: choice('Second') })).body.data;
  assert.equal(secondVersion.version, 2);
  const second = await createSurvey(owner, 'Uses second');
  await owner.post(`/api/surveys/${second._id}/questions/from-library`)
    .send({ questionVersionId: secondVersion._id, qid: '1' });
  const restored = (await owner.post(`/api/library-questions/${item._id}/versions/${item.currentVersionId}/restore`)).body.data;
  assert.equal(restored.version, 1);
  assert.equal(restored.versionId, item.currentVersionId);
  const history = (await owner.get(`/api/library-questions/${item._id}/versions`)).body.data;
  assert.deepEqual(history.map((x) => x.version), [2, 1]);
  assert.equal((await owner.get('/api/library-questions')).body.data.find((x) => x._id === item._id)
    .currentVersionId, item.currentVersionId);
  assert.equal((await db.collection('question_versions').findOne({ _id: new ObjectId(item.currentVersionId) })).content.title, 'First');
  assert.equal((await owner.get(`/api/surveys/${first._id}`)).body.data.draftQuestions[0].title, 'First');
  assert.equal((await owner.get(`/api/surveys/${second._id}`)).body.data.draftQuestions[0].title, 'Second');
  const snapshot = await db.collection('survey_versions').findOne({ surveyId: new ObjectId(first._id) });
  assert.equal(snapshot.questions[0].questionVersionId, item.currentVersionId);
  assert.equal(snapshot.questions[0].title, 'First');
  const savedAnswer = await db.collection('responses').findOne({ _id: new ObjectId(originalAnswer.body.data.id) });
  assert.equal(savedAnswer.versionId.toString(), firstPublish.body.data.versionId);
  assert.deepEqual(savedAnswer.answers, [{ qid: '1', type: 'single', value: 'A' }]);
  assert.equal((await owner.get(`/api/surveys/${first._id}/statistics?versionId=${firstPublish.body.data.versionId}`))
    .body.data.questions[0].counts[0].count, 1);
  const usage = (await owner.get(`/api/library-questions/${item._id}/usage`)).body.data;
  assert.equal(usage.drafts.length, 2);
  assert.equal(usage.published.length, 1);
  assert.deepEqual(usage.drafts.map(({ surveyId, title, qid, questionVersionId }) =>
    ({ surveyId, title, qid, questionVersionId })).sort((a, b) => a.title.localeCompare(b.title)), [
    { surveyId: first._id, title: 'Uses first', qid: '1', questionVersionId: item.currentVersionId },
    { surveyId: second._id, title: 'Uses second', qid: '1', questionVersionId: secondVersion._id }
  ]);
  assert.deepEqual(usage.published[0], { surveyId: first._id, title: 'Uses first',
    surveyVersionId: firstPublish.body.data.versionId, surveyVersion: 1, qid: '1',
    questionVersionId: item.currentVersionId });
  const unchanged = (await owner.get(`/api/surveys/${second._id}`)).body.data.draftQuestions;
  assert.equal((await owner.put(`/api/surveys/${second._id}/questions`).send(unchanged)).body.data[0].questionVersionId,
    secondVersion._id);
  const changed = (await owner.patch(`/api/surveys/${second._id}/questions/1`).send({ title: 'Local edit' })).body.data;
  assert.equal(changed.questionVersionId, undefined);
  assert.equal((await owner.put(`/api/surveys/${second._id}/questions`).send([{
    ...changed, libraryQuestionId: item._id, questionVersionId: item.currentVersionId
  }])).status, 400);
  assert.equal((await owner.post(`/api/surveys/${second._id}/questions`).send({
    qid: '2', ...choice('Forged'), libraryQuestionId: item._id,
    questionVersionId: item.currentVersionId
  })).status, 400);
});

test('cross-survey statistics aggregate matching versions and keep changed versions separate', async () => {
  const owner = await user('stat-owner');
  const respondent = await user('stat-respondent');
  const bank = (await owner.post('/api/question-banks').send({ name: 'Statistics' })).body.data;
  const item = (await owner.post(`/api/question-banks/${bank._id}/questions`)
    .send({ question: choice('Choose') })).body.data;
  const surveys = [];
  for (let index = 0; index < 2; index += 1) {
    const survey = await createSurvey(owner, `Survey ${index}`);
    await owner.post(`/api/surveys/${survey._id}/questions/from-library`)
      .send({ questionVersionId: item.currentVersionId, qid: '1' });
    const published = await owner.post(`/api/surveys/${survey._id}/publish`);
    assert.equal(published.status, 201);
    surveys.push({ ...survey, versionId: published.body.data.versionId });
  }
  const newVersion = (await owner.post(`/api/library-questions/${item._id}/versions`)
    .send({ question: choice('Changed meaning') })).body.data;
  const third = await createSurvey(owner, 'Survey new version');
  await owner.post(`/api/surveys/${third._id}/questions/from-library`)
    .send({ questionVersionId: newVersion._id, qid: '1' });
  surveys.push({ ...third, versionId: (await owner.post(`/api/surveys/${third._id}/publish`)).body.data.versionId });
  for (const [index, survey] of surveys.entries()) {
    const submitted = await respondent.post(`/api/public/surveys/${survey.publicId}/submit`).send({
      versionId: survey.versionId, clientSubmissionId: `library-${index}`, anonymous: false,
      answers: [{ qid: '1', type: 'single', value: index === 2 ? 'B' : 'A' }]
    });
    assert.equal(submitted.status, 201);
  }
  const stats = await owner.get(`/api/library-questions/${item._id}/statistics`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.versions.length, 2);
  assert.deepEqual(stats.body.data.versions.map((x) => x.answerCount), [2, 1]);
  assert.deepEqual(stats.body.data.versions[0].counts.map((x) => x.count), [2, 0]);
  assert.deepEqual(stats.body.data.versions[1].counts.map((x) => x.count), [0, 1]);
  const filtered = await owner.get(`/api/library-questions/${item._id}/statistics?versionId=${newVersion._id}`);
  assert.deepEqual(filtered.body.data.versions.map((x) => x.answerCount), [1]);
  assert.equal((await db.collection('responses').countDocuments({ surveyId: { $in: surveys.map((x) => new ObjectId(x._id)) } })), 3);
});

test('cross-survey multi counts selections separately from respondents and number statistics average answers', async () => {
  const owner = await user('mixed-stat-owner');
  const respondent = await user('mixed-stat-respondent');
  const bank = (await owner.post('/api/question-banks').send({ name: 'Mixed' })).body.data;
  const multi = (await owner.post(`/api/question-banks/${bank._id}/questions`).send({ question: {
    type: 'multi', title: 'Fruit', required: true,
    options: [{ id: 'A', text: 'Apple' }, { id: 'B', text: 'Banana' }]
  } })).body.data;
  const number = (await owner.post(`/api/question-banks/${bank._id}/questions`).send({ question: {
    type: 'number', title: 'Age', required: true, validation: { min: 0, max: 120, integer: true }
  } })).body.data;
  for (let index = 0; index < 2; index += 1) {
    const survey = await createSurvey(owner, `Mixed survey ${index}`);
    await owner.post(`/api/surveys/${survey._id}/questions/from-library`)
      .send({ questionVersionId: multi.currentVersionId, qid: '1' });
    await owner.post(`/api/surveys/${survey._id}/questions/from-library`)
      .send({ questionVersionId: number.currentVersionId, qid: '2' });
    const published = await owner.post(`/api/surveys/${survey._id}/publish`);
    assert.equal(published.status, 201);
    const submitted = await respondent.post(`/api/public/surveys/${survey.publicId}/submit`).send({
      versionId: published.body.data.versionId, clientSubmissionId: `mixed-${index}`,
      anonymous: false, answers: [
        { qid: '1', type: 'multi', value: index ? ['B'] : ['A', 'B'] },
        { qid: '2', type: 'number', value: index ? 20 : 10 }
      ]
    });
    assert.equal(submitted.status, 201);
  }
  const multiStats = (await owner.get(`/api/library-questions/${multi._id}/statistics`)).body.data.versions[0];
  assert.equal(multiStats.answerCount, 2);
  assert.deepEqual(multiStats.counts.map((x) => x.count), [1, 2]);
  const numberStats = (await owner.get(`/api/library-questions/${number._id}/statistics`)).body.data.versions[0];
  assert.equal(numberStats.answerCount, 2);
  assert.equal(numberStats.avg, 15);
  assert.equal(numberStats.min, 10);
  assert.equal(numberStats.max, 20);
});

test('cross-survey statistics exclude optional empty multi and blank text answers', async () => {
  const owner = await user('empty-stat-owner');
  const first = await user('empty-stat-first');
  const second = await user('empty-stat-second');
  const bank = (await owner.post('/api/question-banks').send({ name: 'Optional' })).body.data;
  const multi = (await owner.post(`/api/question-banks/${bank._id}/questions`).send({ question: {
    type: 'multi', title: 'Optional multi', required: false, options: [{ id: 'A', text: 'A' }]
  } })).body.data;
  const text = (await owner.post(`/api/question-banks/${bank._id}/questions`).send({ question: {
    type: 'text', title: 'Optional text', required: false
  } })).body.data;
  const survey = await createSurvey(owner, 'Optional answers');
  for (const [qid, item] of [['1', multi], ['2', text]]) {
    assert.equal((await owner.post(`/api/surveys/${survey._id}/questions/from-library`)
      .send({ questionVersionId: item.currentVersionId, qid })).status, 201);
  }
  const versionId = (await owner.post(`/api/surveys/${survey._id}/publish`)).body.data.versionId;
  const submit = (agent, suffix, values) => agent.post(`/api/public/surveys/${survey.publicId}/submit`).send({
    versionId, clientSubmissionId: suffix, anonymous: false, answers: [
      { qid: '1', type: 'multi', value: values[0] }, { qid: '2', type: 'text', value: values[1] }
    ]
  });
  assert.equal((await submit(first, 'empty', [[], '  '])).status, 201);
  assert.equal((await submit(second, 'filled', [['A'], 'hello'])).status, 201);
  const multiStats = (await owner.get(`/api/library-questions/${multi._id}/statistics`)).body.data.versions[0];
  const textStats = (await owner.get(`/api/library-questions/${text._id}/statistics`)).body.data.versions[0];
  assert.equal(multiStats.answerCount, 1);
  assert.equal(multiStats.counts[0].count, 1);
  assert.equal(textStats.answerCount, 1);
  assert.deepEqual(textStats.values, ['hello']);
  assert.equal(await db.collection('responses').countDocuments({ surveyId: new ObjectId(survey._id) }), 2);
});

test('saving a published source question counts its existing answer as library usage', async () => {
  const owner = await user('origin-owner');
  const respondent = await user('origin-respondent');
  const survey = await createSurvey(owner, 'Mother survey');
  assert.equal((await owner.post(`/api/surveys/${survey._id}/questions`)
    .send({ qid: '1', ...choice('Mother') })).status, 201);
  const published = await owner.post(`/api/surveys/${survey._id}/publish`);
  assert.equal(published.status, 201);
  assert.equal((await respondent.post(`/api/public/surveys/${survey.publicId}/submit`).send({
    versionId: published.body.data.versionId, clientSubmissionId: 'mother-1', anonymous: false,
    answers: [{ qid: '1', type: 'single', value: 'A' }]
  })).status, 201);
  assert.equal((await owner.get(`/api/surveys/${survey._id}/draft`)).status, 200);
  const saved = await owner.post('/api/library-questions').send({ surveyId: survey._id, qid: '1' });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.data.bankId, null);
  assert.equal(saved.body.data.originRefs.length, 1);
  const stats = await owner.get(`/api/library-questions/${saved.body.data._id}/statistics`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.versions[0].answerCount, 1);
  assert.equal(stats.body.data.versions[0].surveyVersionCount, 1);
  const usage = await owner.get(`/api/library-questions/${saved.body.data._id}/usage`);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.data.published.length, 1);
  assert.deepEqual(usage.body.data.published[0], { surveyId: survey._id, title: 'Mother survey',
    surveyVersionId: published.body.data.versionId, surveyVersion: 1, qid: '1',
    questionVersionId: saved.body.data.currentVersionId });
  assert.equal(stats.body.data.versions[0].counts[0].count, 1);
  assert.equal((await owner.get('/api/library-questions')).body.data.some((item) =>
    item._id === saved.body.data._id), true);
});

test('batch move, select, and archive keep saved survey questions intact', async () => {
  const owner = await user('batch-owner');
  const bank = (await owner.post('/api/question-banks').send({ name: 'Moved' })).body.data;
  const first = (await owner.post('/api/library-questions').send({ question: choice('First batch') })).body.data;
  const second = (await owner.post('/api/library-questions').send({ question: choice('Second batch') })).body.data;
  const ids = [first._id, second._id];
  const moved = await owner.post('/api/library-questions/batch').send({ ids, action: 'move', bankId: bank._id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.count, 2);
  assert.equal((await owner.get(`/api/question-banks/${bank._id}/questions`)).body.data.length, 2);
  const survey = await createSurvey(owner, 'Batch selection');
  const selected = await owner.post(`/api/surveys/${survey._id}/questions/from-library/batch`)
    .send({ questionVersionIds: [first.currentVersionId, second.currentVersionId] });
  assert.equal(selected.status, 201);
  assert.deepEqual(selected.body.data.map((item) => item.qid), ['1', '2']);
  const published = await owner.post(`/api/surveys/${survey._id}/publish`);
  assert.equal(published.status, 201);
  const archived = await owner.post('/api/library-questions/batch').send({ ids, action: 'archive' });
  assert.equal(archived.status, 200);
  assert.equal((await owner.get('/api/library-questions')).body.data.some((item) => ids.includes(item._id)), false);
  assert.equal((await db.collection('library_questions').countDocuments({ _id: { $in: ids.map((value) => new ObjectId(value)) }, archivedAt: { $exists: true } })), 2);
  assert.deepEqual((await owner.get(`/api/surveys/${survey._id}`)).body.data.draftQuestions.map((item) => item.title),
    ['First batch', 'Second batch']);
  assert.equal((await db.collection('survey_versions').findOne({ _id: new ObjectId(published.body.data.versionId) })).questions.length, 2);
});

test('overwriting a version republishes owned usage and preserves prior answers', async () => {
  const owner = await user('overwrite-owner');
  const respondent = await user('overwrite-respondent');
  const importer = await user('overwrite-importer');
  const item = (await owner.post('/api/library-questions').send({ question: choice('Before') })).body.data;
  const token = (await owner.post(`/api/library-questions/${item._id}/share-link`)).body.data.token;
  const imported = (await importer.post('/api/library-questions/import').send({ token })).body.data;
  const survey = await createSurvey(owner, 'Overwrite usage');
  assert.equal((await owner.post(`/api/surveys/${survey._id}/questions/from-library`)
    .send({ questionVersionId: item.currentVersionId, qid: '1' })).status, 201);
  const first = await owner.post(`/api/surveys/${survey._id}/publish`);
  assert.equal(first.status, 201);
  assert.equal((await respondent.post(`/api/public/surveys/${survey.publicId}/submit`).send({
    versionId: first.body.data.versionId, clientSubmissionId: 'old-answer', anonymous: false,
    answers: [{ qid: '1', type: 'single', value: 'A' }]
  })).status, 201);
  const updated = await owner.put(`/api/library-questions/${item._id}/versions/${item.currentVersionId}`)
    .send({ question: choice('After') });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.contentRevision, 2);
  assert.equal(updated.body.data.updatedSurveys, 1);
  assert.equal((await importer.get(`/api/library-questions/${imported._id}/versions`))
    .body.data[0].content.title, 'Before');
  const record = (await owner.get(`/api/surveys/${survey._id}`)).body.data;
  assert.equal(record.draftQuestions[0].title, 'After');
  assert.notEqual(record.publishedVersionId, first.body.data.versionId);
  const snapshots = await db.collection('survey_versions').find({ surveyId: new ObjectId(survey._id) })
    .sort({ version: 1 }).toArray();
  assert.deepEqual(snapshots.map((entry) => entry.questions[0].title), ['Before', 'After']);
  assert.equal((await owner.get(`/api/surveys/${survey._id}/statistics?versionId=${first.body.data.versionId}`))
    .body.data.questions[0].counts[0].count, 1);
  const stats = (await owner.get(`/api/library-questions/${item._id}/statistics`)).body.data.versions[0];
  assert.deepEqual(stats.revisions.map((entry) => entry.answerCount), [1, 0]);
  assert.deepEqual(stats.revisions.map((entry) => entry.surveyVersionCount), [1, 1]);
  assert.equal(await db.collection('responses').countDocuments({ surveyId: new ObjectId(survey._id) }), 1);
});

test('version lineage survives selecting an old default and rejects foreign sources', async () => {
  const owner = await user('lineage-owner');
  const other = await user('lineage-other');
  const first = (await owner.post('/api/library-questions').send({ question: choice('First') })).body.data;
  const foreign = (await other.post('/api/library-questions').send({ question: choice('Foreign') })).body.data;
  const base = `/api/library-questions/${first._id}`;
  const second = await owner.post(`${base}/versions`).send({ question: choice('Second') });
  assert.equal(second.status, 201);
  assert.equal(second.body.data.sourceVersionId, first.currentVersionId);
  const before = await db.collection('question_versions').countDocuments({ questionId: new ObjectId(first._id) });
  const invalid = await owner.post(`${base}/versions`).send({
    question: choice('Invalid'), sourceVersionId: foreign.currentVersionId
  });
  assert.equal(invalid.status, 404);
  assert.equal(invalid.body.code, 'NOT_FOUND');
  assert.equal((await owner.post(`${base}/versions/${foreign.currentVersionId}/restore`)).status, 404);
  assert.equal(await db.collection('question_versions').countDocuments({ questionId: new ObjectId(first._id) }), before);
  const restored = await owner.post(`${base}/versions/${first.currentVersionId}/restore`);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.data, { versionId: first.currentVersionId, version: 1 });
  const third = await owner.post(`${base}/versions`).send({ question: choice('Third') });
  assert.equal(third.status, 201);
  assert.equal(third.body.data.version, 3);
  assert.equal(third.body.data.sourceVersionId, first.currentVersionId);
  const history = (await owner.get(`${base}/versions`)).body.data;
  assert.deepEqual(history.map(({ version, content }) => [version, content.title]),
    [[3, 'Third'], [2, 'Second'], [1, 'First']]);
  assert.equal((await db.collection('library_questions').findOne({ _id: new ObjectId(first._id) }))
    .currentVersionId.toString(), third.body.data._id);
});

test('share links reject malformed, rotated, owned and archived imports without creating copies', async () => {
  const owner = await user('link-boundary-owner');
  const receiver = await user('link-boundary-receiver');
  const item = (await owner.post('/api/library-questions').send({ question: choice('Share boundary') })).body.data;
  const base = `/api/library-questions/${item._id}`;
  const before = await db.collection('library_questions').countDocuments({ ownerId: new ObjectId(
    (await db.collection('users').findOne({ username: 'link-boundary-receiver' }))._id) });
  assert.equal((await receiver.post('/api/library-questions/import').send({ token: 'short' })).status, 400);
  assert.equal((await receiver.post('/api/library-questions/import').send({ token: 'x'.repeat(43) })).status, 404);
  assert.equal((await receiver.post(`${base}/share-link`)).status, 403);
  const first = (await owner.post(`${base}/share-link`)).body.data.token;
  assert.equal((await owner.post('/api/library-questions/import').send({ token: first })).status, 400);
  const second = (await owner.post(`${base}/share-link`)).body.data.token;
  assert.notEqual(first, second);
  assert.equal((await receiver.post('/api/library-questions/import').send({ token: first })).status, 404);
  assert.equal((await owner.post('/api/library-questions/batch').send({ ids: [item._id], action: 'archive' })).status, 200);
  assert.equal((await receiver.post('/api/library-questions/import').send({ token: second })).status, 404);
  assert.equal(await db.collection('library_questions').countDocuments({ ownerId: new ObjectId(
    (await db.collection('users').findOne({ username: 'link-boundary-receiver' }))._id) }), before);
});

test('failed batch operations leave library placement and survey questions unchanged', async () => {
  const owner = await user('batch-boundary-owner');
  const other = await user('batch-boundary-other');
  const own = (await owner.post('/api/library-questions').send({ question: choice('Owned') })).body.data;
  const foreign = (await other.post('/api/library-questions').send({ question: choice('Private') })).body.data;
  const foreignBank = (await other.post('/api/question-banks').send({ name: 'Private bank' })).body.data;
  const survey = await createSurvey(owner, 'Batch failures');
  const batch = (body) => owner.post('/api/library-questions/batch').send(body);
  const insert = (questionVersionIds) => owner.post(`/api/surveys/${survey._id}/questions/from-library/batch`)
    .send({ questionVersionIds });
  assert.equal((await batch({ ids: [own._id, own._id], action: 'archive' })).status, 400);
  assert.equal((await batch({ ids: [own._id, foreign._id], action: 'archive' })).status, 403);
  assert.equal((await batch({ ids: [own._id], action: 'move', bankId: foreignBank._id })).status, 403);
  assert.equal((await insert([own.currentVersionId, own.currentVersionId])).status, 400);
  assert.equal((await insert([own.currentVersionId, foreign.currentVersionId])).status, 403);
  assert.equal((await insert([own.currentVersionId, new ObjectId().toString()])).status, 403);
  assert.deepEqual((await owner.get(`/api/surveys/${survey._id}`)).body.data.draftQuestions, []);
  let record = await db.collection('library_questions').findOne({ _id: new ObjectId(own._id) });
  assert.equal(record.bankId, null);
  assert.equal(record.archivedAt, undefined);
  assert.equal((await batch({ ids: [own._id], action: 'archive' })).status, 200);
  assert.equal((await insert([own.currentVersionId])).status, 403);
  assert.deepEqual((await owner.get(`/api/surveys/${survey._id}`)).body.data.draftQuestions, []);
  record = await db.collection('library_questions').findOne({ _id: new ObjectId(own._id) });
  assert.ok(record.archivedAt instanceof Date);
  assert.equal(await db.collection('survey_versions').countDocuments({ surveyId: new ObjectId(survey._id) }), 0);
});

test('cross-survey statistics isolate owners and versions, including unanswered snapshots', async () => {
  const owner = await user('stat-isolation-owner');
  const other = await user('stat-isolation-other');
  const respondent = await user('stat-isolation-respondent');
  const item = (await owner.post('/api/library-questions').send({ question: choice('Owner answer') })).body.data;
  const token = (await owner.post(`/api/library-questions/${item._id}/share-link`)).body.data.token;
  const copied = (await other.post('/api/library-questions/import').send({ token })).body.data;
  const owned = await createSurvey(owner, 'Unanswered owner snapshot');
  const outsider = await createSurvey(other, 'Answered imported snapshot');
  for (const [agent, survey, versionId] of [[owner, owned, item.currentVersionId],
    [other, outsider, copied.currentVersionId]]) {
    assert.equal((await agent.post(`/api/surveys/${survey._id}/questions/from-library`)
      .send({ questionVersionId: versionId, qid: '1' })).status, 201);
  }
  const ownerPublished = await owner.post(`/api/surveys/${owned._id}/publish`);
  const otherPublished = await other.post(`/api/surveys/${outsider._id}/publish`);
  assert.equal(ownerPublished.status, 201);
  assert.equal(otherPublished.status, 201);
  assert.equal((await respondent.post(`/api/public/surveys/${outsider.publicId}/submit`).send({
    versionId: otherPublished.body.data.versionId, clientSubmissionId: 'imported-answer',
    anonymous: false, answers: [{ qid: '1', type: 'single', value: 'A' }]
  })).status, 201);
  const stats = await owner.get(`/api/library-questions/${item._id}/statistics`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.versions[0].surveyVersionCount, 1);
  assert.equal(stats.body.data.versions[0].answerCount, 0);
  assert.deepEqual(stats.body.data.versions[0].counts.map((entry) => entry.count), [0, 0]);
  assert.equal((await owner.get(`/api/library-questions/${item._id}/usage`)).body.data.published.length, 1);
  assert.equal((await owner.get(`/api/library-questions/${item._id}/statistics?versionId=${copied.currentVersionId}`)).status, 404);
  assert.equal((await other.get(`/api/library-questions/${item._id}/statistics`)).status, 403);
  assert.equal((await db.collection('responses').countDocuments({ surveyId: new ObjectId(outsider._id) })), 1);
});

test('legacy questions without library links remain readable and statistically independent', async () => {
  const owner = await user('legacy-library-owner');
  const respondent = await user('legacy-library-respondent');
  const survey = await createSurvey(owner, 'Legacy question');
  assert.equal((await owner.post(`/api/surveys/${survey._id}/questions`)
    .send({ qid: '1', ...choice('Plain question') })).status, 201);
  const published = await owner.post(`/api/surveys/${survey._id}/publish`);
  assert.equal(published.status, 201);
  assert.equal((await respondent.post(`/api/public/surveys/${survey.publicId}/submit`).send({
    versionId: published.body.data.versionId, clientSubmissionId: 'legacy-library-answer',
    anonymous: false, answers: [{ qid: '1', type: 'single', value: 'B' }]
  })).status, 201);
  const legacy = (await owner.get(`/api/surveys/${survey._id}`)).body.data.draftQuestions[0];
  assert.equal(legacy.libraryQuestionId, undefined);
  assert.equal(legacy.questionVersionId, undefined);
  const snapshot = await db.collection('survey_versions').findOne({ _id: new ObjectId(published.body.data.versionId) });
  assert.equal(snapshot.questions[0].libraryQuestionId, undefined);
  const stats = (await owner.get(`/api/surveys/${survey._id}/statistics`)).body.data;
  assert.equal(stats.totalResponses, 1);
  assert.deepEqual(stats.questions[0].counts.map((entry) => entry.count), [0, 1]);
  const unrelated = (await owner.post('/api/library-questions').send({ question: choice('Unrelated') })).body.data;
  const libraryStats = (await owner.get(`/api/library-questions/${unrelated._id}/statistics`)).body.data;
  assert.equal(libraryStats.versions[0].answerCount, 0);
  assert.equal(libraryStats.versions[0].surveyVersionCount, 0);
});

test('MongoDB initialization can be repeated and preserves legacy survey documents', async (t) => {
  const probe = spawnSync('mongosh', ['--version'], { encoding: 'utf8' });
  if (probe.error) { t.skip('mongosh is unavailable in this environment'); return; }
  const initDb = client.db(`survey_init_test_${new ObjectId()}`);
  try {
    const old = await initDb.collection('surveys').insertOne({ ownerId: new ObjectId(), publicId: `old-${new ObjectId()}`,
      title: 'Legacy', description: '', allowAnonymous: true, allowMultiple: false, status: 'draft',
      deadline: null, draftQuestions: [], draftBaseVersionId: null, publishedVersionId: null,
      createdAt: new Date(), updatedAt: new Date() });
    const script = path.join(__dirname, '..', 'database', 'init-mongodb.js');
    const testUri = new URL(uri);
    testUri.pathname = `/${initDb.databaseName}`;
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync('mongosh', [testUri.toString(), '--quiet', '--file', script],
        { encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    assert.equal((await initDb.collection('surveys').findOne({ _id: old.insertedId })).title, 'Legacy');
    assert.ok((await initDb.collection('question_versions').indexes()).some((index) => index.name === 'question_version_unique'));
  } finally {
    await initDb.dropDatabase();
  }
});
