'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const request = require('supertest');
const { MongoClient, ObjectId } = require('mongodb');
const { createApp } = require('../src/app');
const { closeExpiredSurveys } = require('../src/survey-status');

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
let client;
let db;
let app;

test.before(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(`survey_api_test_${new ObjectId()}`);
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('surveys').createIndex({ publicId: 1 }, { unique: true });
  await db.collection('survey_versions').createIndex({ surveyId: 1, version: 1 }, { unique: true });
  await db.collection('responses').createIndex({ surveyId: 1, respondentKey: 1, clientSubmissionId: 1 }, { unique: true });
  await db.collection('responses').createIndex({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
  app = createApp(db, { sessionSecret: 'test-secret-with-at-least-32-characters' });
});

test.after(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

test('registration hashes passwords, rejects duplicates and supports login/logout', async () => {
  const payload = { username: 'registration-user', password: 'good-password' };
  const registered = await request(app).post('/api/auth/register').send(payload);
  assert.equal(registered.status, 201);
  assert.equal(registered.body.code, 0);
  assert.ok(registered.headers['set-cookie'][0].includes('HttpOnly'));
  const user = await db.collection('users').findOne({ username: payload.username });
  assert.notEqual(user.passwordHash, payload.password);
  assert.equal(await bcrypt.compare(payload.password, user.passwordHash), true);

  const duplicate = await request(app).post('/api/auth/register').send(payload);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'ALREADY_EXISTS');
  const invalid = await request(app).post('/api/auth/register').send({ username: 'short', password: 'x' });
  assert.equal(invalid.body.code, 'VALIDATION_ERROR');
  const malformed = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send('{bad');
  assert.equal(malformed.body.code, 'VALIDATION_ERROR');

  const wrong = await request(app).post('/api/auth/login').send({ username: payload.username, password: 'wrong-password' });
  assert.equal(wrong.body.code, 'INVALID_CREDENTIALS');
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send(payload);
  assert.equal(login.status, 200);
  assert.equal((await agent.get('/api/auth/me')).body.data.username, payload.username);
  assert.equal((await agent.post('/api/auth/logout')).status, 200);
  assert.equal((await agent.get('/api/auth/me')).body.code, 'LOGIN_REQUIRED');
});

test('the app serves its single-page frontend and assets', async () => {
  const page = await request(app).get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /id="auth-form"/);
  assert.match(page.text, /id="survey-list"/);
  assert.match(page.text, /id="answer-form"/);
  assert.equal((await request(app).get('/app.js')).status, 200);
  assert.equal((await request(app).get('/styles.css')).status, 200);
});

test('survey creation requires login and valid fields; mine is owner scoped', async () => {
  assert.equal((await request(app).post('/api/surveys').send({ title: 'Survey' })).body.code, 'LOGIN_REQUIRED');
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'survey-owner', password: 'good-password' });
  assert.equal((await owner.post('/api/surveys').send({})).body.code, 'VALIDATION_ERROR');
  const created = await owner.post('/api/surveys').send({ title: 'Survey' });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, 'draft');
  assert.equal(created.body.data.publishedVersionId, null);
  assert.deepEqual(created.body.data.draftQuestions, []);
  assert.equal((await owner.get('/api/surveys/mine')).body.data.length, 1);

  const outsider = request.agent(app);
  await outsider.post('/api/auth/register').send({ username: 'outsider', password: 'other-password' });
  assert.deepEqual((await outsider.get('/api/surveys/mine')).body.data, []);
  const id = created.body.data._id;
  assert.equal((await outsider.get(`/api/surveys/${id}`)).body.code, 'NOT_OWNER');
  assert.equal((await outsider.patch(`/api/surveys/${id}`).send({ title: 'Changed' })).body.code, 'NOT_OWNER');
  assert.equal((await outsider.post(`/api/surveys/${id}/questions`).send({ qid: 'q', type: 'text', title: 'Q', required: true })).body.code, 'NOT_OWNER');
  assert.equal((await outsider.put(`/api/surveys/${id}/questions`).send([])).body.code, 'NOT_OWNER');
  assert.equal((await outsider.patch(`/api/surveys/${id}/questions/q`).send({ title: 'Changed' })).body.code, 'NOT_OWNER');
  assert.equal((await outsider.delete(`/api/surveys/${id}/questions/q`)).body.code, 'NOT_OWNER');
});

test('draft question CRUD validates types, blocks duplicate ids and locks published records', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'question-owner', password: 'good-password' });
  const created = await owner.post('/api/surveys').send({ title: 'Editable' });
  const id = created.body.data._id;
  const base = `/api/surveys/${id}`;
  const questions = [
    { qid: 'single', type: 'single', title: 'Single', required: true, options: [{ id: 'A', text: 'A' }] },
    { qid: 'multi', type: 'multi', title: 'Multi', required: false, options: [{ id: 'B', text: 'B' }] },
    { qid: 'text', type: 'text', title: 'Text', required: true },
    { qid: 'number', type: 'number', title: 'Number', required: true, validation: { min: 0, integer: true } }
  ];
  for (const question of questions) {
    assert.equal((await owner.post(`${base}/questions`).send(question)).status, 201);
  }
  assert.equal((await owner.post(`${base}/questions`).send(questions[0])).body.code, 'CONFLICT');
  assert.equal((await owner.post(`${base}/questions`).send({ qid: 'bad', type: 'unknown', title: 'Bad', required: true })).body.code, 'VALIDATION_ERROR');
  assert.equal((await owner.patch(`${base}/questions/text`).send({ title: 'Updated' })).body.data.title, 'Updated');
  assert.equal((await owner.patch(`${base}/questions/text`).send({ qid: 'changed' })).body.code, 'VALIDATION_ERROR');
  assert.equal((await owner.delete(`${base}/questions/text`)).status, 200);
  assert.equal((await owner.get(base)).body.data.draftQuestions.length, 3);
  assert.equal((await owner.patch(base).send({ title: 'Renamed' })).body.data.title, 'Renamed');

  await db.collection('surveys').updateOne({ _id: new (require('mongodb').ObjectId)(id) }, { $set: { status: 'published' } });
  assert.equal((await owner.post(`${base}/questions`).send({ qid: 'late', type: 'text', title: 'Late', required: true })).body.code, 'SURVEY_LOCKED');
  assert.equal((await owner.patch(`${base}/questions/multi`).send({ title: 'Late' })).body.code, 'SURVEY_LOCKED');
  assert.equal((await owner.delete(`${base}/questions/multi`)).body.code, 'SURVEY_LOCKED');
  assert.equal((await owner.patch(base).send({ title: 'Late' })).body.code, 'SURVEY_LOCKED');
});

test('draft questions can be replaced atomically and published questions stay locked', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'replace-owner', password: 'good-password' });
  const id = (await owner.post('/api/surveys').send({ title: 'Reorder' })).body.data._id;
  const url = `/api/surveys/${id}/questions`;
  const questions = [
    { qid: '1', type: 'single', title: 'Choose', required: true,
      options: [{ id: 'A', text: 'Yes' }], jumpRules: [{ id: 'r1', when: { optionId: 'A' }, targetQid: '2' }] },
    { qid: '2', type: 'text', title: 'Explain', required: false, options: [], validation: {}, jumpRules: [] }
  ];
  assert.equal((await owner.put(url).send(questions)).status, 200);
  assert.deepEqual((await owner.get(`/api/surveys/${id}`)).body.data.draftQuestions, questions);
  assert.equal((await owner.put(url).send([questions[0], questions[0]])).body.code, 'VALIDATION_ERROR');
  assert.equal((await owner.put(url).send([{ ...questions[0], type: 'unknown' }])).body.code, 'VALIDATION_ERROR');
  assert.deepEqual((await owner.get(`/api/surveys/${id}`)).body.data.draftQuestions, questions);
  await db.collection('surveys').updateOne({ _id: new (require('mongodb').ObjectId)(id) }, { $set: { status: 'published' } });
  assert.equal((await owner.put(url).send([])).body.code, 'SURVEY_LOCKED');
});

test('published editing creates a new version without changing old fills or statistics', async () => {
  const owner = request.agent(app);
  const firstRespondent = request.agent(app);
  const secondRespondent = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'version-owner', password: 'good-password' });
  await firstRespondent.post('/api/auth/register').send({ username: 'version-first', password: 'good-password' });
  await secondRespondent.post('/api/auth/register').send({ username: 'version-second', password: 'good-password' });
  const created = (await owner.post('/api/surveys').send({ title: 'Versions', allowMultiple: true })).body.data;
  const base = `/api/surveys/${created._id}`;
  const publicBase = `/api/public/surveys/${created.publicId}`;
  const oldQuestions = [
    { qid: '1', type: 'single', title: 'Original choice', required: true,
      options: [{ id: 'A', text: 'Yes' }], jumpRules: [{ id: 'r1', when: { optionId: 'A' }, targetQid: '2' }] },
    { qid: '2', type: 'number', title: 'Original number', required: true }
  ];
  assert.equal((await owner.put(`${base}/questions`).send(oldQuestions)).status, 200);
  const first = await owner.post(`${base}/publish`);
  assert.equal(first.body.data.version, 1);
  const v1 = first.body.data.versionId;
  assert.equal((await firstRespondent.get(publicBase)).body.data.versionId, v1);
  const oldAnswers = [{ qid: '1', type: 'single', value: 'A' }, { qid: '2', type: 'number', value: 10 }];
  assert.equal((await firstRespondent.post(`${publicBase}/submit`).send({
    versionId: v1, clientSubmissionId: 'first', anonymous: false, answers: oldAnswers
  })).status, 201);

  assert.equal((await firstRespondent.get(`${base}/draft`)).body.code, 'NOT_OWNER');
  assert.equal((await owner.put(`${base}/questions`).send([])).body.code, 'SURVEY_LOCKED');
  const draft = await owner.get(`${base}/draft`);
  assert.equal(draft.status, 200);
  assert.equal(draft.body.data.draftBaseVersionId, v1);
  assert.deepEqual(draft.body.data.draftQuestions, oldQuestions);
  assert.equal((await owner.get(`${base}/draft`)).body.data.draftBaseVersionId, v1);
  const revised = [
    { qid: '1', type: 'number', title: 'Reordered number', required: true },
    { qid: '2', type: 'single', title: 'New choice', required: true, options: [{ id: 'B', text: 'No' }] }
  ];
  assert.equal((await owner.put(`${base}/questions`).send(revised)).status, 200);
  assert.deepEqual((await owner.get(`${base}/draft`)).body.data.draftQuestions, revised);
  const invalidDraft = [{ ...revised[0], jumpRules: [{ id: 'r1', when: { op: 'gt', value: 0 }, targetQid: 'missing' }] }, revised[1]];
  assert.equal((await owner.put(`${base}/questions`).send(invalidDraft)).status, 200);
  assert.equal((await owner.post(`${base}/publish`)).body.code, 'INVALID_SURVEY_LOGIC');
  assert.equal((await secondRespondent.get(publicBase)).body.data.versionId, v1);
  assert.equal((await owner.put(`${base}/questions`).send(revised)).status, 200);
  assert.equal((await secondRespondent.get(publicBase)).body.data.questions[0].title, 'Original choice');
  assert.equal((await owner.post(`${base}/publish`)).status, 201);
  const current = (await owner.get(base)).body.data;
  const v2 = current.publishedVersionId;
  assert.notEqual(v1, v2);
  assert.equal(current.draftBaseVersionId, null);
  assert.equal((await secondRespondent.get(publicBase)).body.data.versionId, v2);
  assert.equal((await owner.get(`${base}/versions`)).body.data.length, 2);
  assert.equal((await owner.put(`${base}/questions`).send(revised)).body.code, 'SURVEY_LOCKED');
  const oldSnapshot = await db.collection('survey_versions').findOne({ _id: new (require('mongodb').ObjectId)(v1) });
  assert.deepEqual(oldSnapshot.questions, oldQuestions);

  assert.equal((await secondRespondent.post(`${publicBase}/next`).send({
    versionId: v1, currentQid: '1', answers: [oldAnswers[0]]
  })).body.data.nextQid, '2');
  assert.equal((await secondRespondent.post(`${publicBase}/submit`).send({
    versionId: v1, clientSubmissionId: 'old-in-flight', anonymous: false, answers: oldAnswers
  })).status, 201);
  assert.equal((await firstRespondent.post(`${publicBase}/submit`).send({
    versionId: v2, clientSubmissionId: 'new', anonymous: false,
    answers: [{ qid: '1', type: 'number', value: 25 }, { qid: '2', type: 'single', value: 'B' }]
  })).status, 201);
  const oldStats = (await owner.get(`${base}/statistics?versionId=${v1}`)).body.data;
  const newStats = (await owner.get(`${base}/statistics`)).body.data;
  assert.equal(oldStats.totalResponses, 2);
  assert.equal(oldStats.questions[0].title, 'Original choice');
  assert.equal(newStats.totalResponses, 1);
  assert.equal(newStats.versionId, v2);
  assert.equal(newStats.questions[0].title, 'Reordered number');
});

test('publish validates logic, freezes a version and serves only public fields', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'publish-owner', password: 'good-password' });
  const created = await owner.post('/api/surveys').send({ title: 'Published survey' });
  const id = created.body.data._id;
  const publicId = created.body.data.publicId;
  assert.equal((await owner.post(`/api/surveys/${id}/publish`)).body.code, 'INVALID_SURVEY_LOGIC');
  const first = { qid: 'start', type: 'single', title: 'Start', required: true, options: [{ id: 'skip', text: 'Skip' }], jumpRules: [{ id: 'r1', when: { optionId: 'skip' }, targetQid: 'missing' }] };
  await owner.post(`/api/surveys/${id}/questions`).send(first);
  assert.equal((await owner.post(`/api/surveys/${id}/publish`)).body.code, 'INVALID_SURVEY_LOGIC');
  await owner.post(`/api/surveys/${id}/questions`).send({ qid: 'middle', type: 'text', title: 'Middle', required: true });
  await owner.post(`/api/surveys/${id}/questions`).send({ qid: 'missing', type: 'number', title: 'End', required: true });
  await owner.patch(`/api/surveys/${id}/questions/missing`).send({
    jumpRules: [{ id: 'loop', when: { op: 'gte', value: 0 }, targetQid: 'middle' }]
  });
  const cycle = await owner.post(`/api/surveys/${id}/publish`);
  assert.equal(cycle.status, 400);
  assert.equal(cycle.body.code, 'INVALID_SURVEY_LOGIC');
  await owner.patch(`/api/surveys/${id}/questions/missing`).send({ jumpRules: [] });
  const published = await owner.post(`/api/surveys/${id}/publish`);
  assert.equal(published.status, 201);
  const versionId = published.body.data.versionId;
  const snapshot = await db.collection('survey_versions').findOne({ _id: new (require('mongodb').ObjectId)(versionId) });
  assert.equal(snapshot.questions.length, 3);
  assert.equal(snapshot.questions[0].title, 'Start');
  await db.collection('surveys').updateOne({ _id: new (require('mongodb').ObjectId)(id) }, { $set: { 'draftQuestions.0.title': 'Draft changed' } });
  const publicView = await owner.get(`/api/public/surveys/${publicId}`);
  assert.equal(publicView.body.data.versionId, versionId);
  assert.equal(publicView.body.data.questions[0].title, 'Start');
  assert.equal(publicView.body.data.ownerId, undefined);
  assert.equal(publicView.body.data.draftQuestions, undefined);
  assert.equal((await owner.post(`/api/surveys/${id}/publish`)).body.code, 'SURVEY_LOCKED');
  assert.equal((await owner.patch(`/api/surveys/${id}/questions/middle`).send({ title: 'Changed' })).body.code, 'SURVEY_LOCKED');
});

test('submission replays the version path and makes retries idempotent', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'response-owner', password: 'good-password' });
  const created = await owner.post('/api/surveys').send({ title: 'Response survey', allowAnonymous: true, allowMultiple: false });
  const id = created.body.data._id;
  const publicId = created.body.data.publicId;
  for (const question of [
    { qid: 'entry', type: 'single', title: 'Entry', required: true, options: [{ id: 'A', text: 'A' }], jumpRules: [{ id: 'skip', when: { optionId: 'A' }, targetQid: 'end' }] },
    { qid: 'skipped', type: 'text', title: 'Skipped required', required: true },
    { qid: 'end', type: 'number', title: 'End', required: true }
  ]) await owner.post(`/api/surveys/${id}/questions`).send(question);
  const versionId = (await owner.post(`/api/surveys/${id}/publish`)).body.data.versionId;
  const endpoint = `/api/public/surveys/${publicId}/submit`;
  const nextEndpoint = `/api/public/surveys/${publicId}/next`;
  const submission = {
    versionId, clientSubmissionId: 'retry-key', anonymous: true,
    answers: [{ qid: 'entry', type: 'single', value: 'A' }, { qid: 'end', type: 'number', value: 0 }]
  };
  const next = await owner.post(nextEndpoint).send({ versionId, currentQid: 'entry', answers: [submission.answers[0]] });
  assert.equal(next.status, 200);
  assert.equal(next.body.data.nextQid, 'end');
  assert.equal((await owner.post(nextEndpoint).send({ versionId, currentQid: 'skipped', answers: [submission.answers[0]] })).body.code, 'JUMP_PATH_MISMATCH');
  assert.equal((await owner.post(nextEndpoint).send({ versionId, currentQid: 'end', answers: submission.answers })).body.data.nextQid, null);
  assert.equal((await owner.post(nextEndpoint).send({ versionId, currentQid: 'end', answers: submission.answers.slice(0, 1) })).body.code, 'VALIDATION_ERROR');
  assert.equal((await request(app).post(endpoint).send(submission)).body.code, 'LOGIN_REQUIRED');
  const outside = await owner.post(endpoint).send({ ...submission, answers: [...submission.answers, { qid: 'skipped', type: 'text', value: 'extra' }] });
  assert.equal(outside.body.code, 'JUMP_PATH_MISMATCH');
  assert.equal((await owner.post(endpoint).send({ ...submission, answers: submission.answers.slice(0, 1) })).body.code, 'VALIDATION_ERROR');
  assert.equal((await owner.post(endpoint).send({ ...submission, versionId: '000000000000000000000001' })).body.code, 'VERSION_EXPIRED');
  const first = await owner.post(endpoint).send(submission);
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.data.path, ['entry', 'end']);
  const repeat = await owner.post(endpoint).send(submission);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.data.id, first.body.data.id);
  assert.deepEqual(Object.keys(repeat.body.data).sort(), ['id', 'path', 'submittedAt', 'versionId']);
  assert.equal((await db.collection('responses').countDocuments({ surveyId: new (require('mongodb').ObjectId)(id) })), 1);
  const stored = await db.collection('responses').findOne({ _id: new (require('mongodb').ObjectId)(first.body.data.id) });
  assert.equal(stored.respondentId, null);
  assert.equal(stored.anonymous, true);
  assert.equal((await owner.post(endpoint).send({ ...submission, clientSubmissionId: 'second-key' })).body.code, 'DUPLICATE_SUBMISSION');
});

test('anonymous policy, multiple submissions, and deadline are enforced', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'policy-owner', password: 'good-password' });
  const created = await owner.post('/api/surveys').send({ title: 'Policy', allowAnonymous: false, allowMultiple: true });
  const id = created.body.data._id;
  const publicId = created.body.data.publicId;
  await owner.post(`/api/surveys/${id}/questions`).send({ qid: 'note', type: 'text', title: 'Note', required: true });
  const versionId = (await owner.post(`/api/surveys/${id}/publish`)).body.data.versionId;
  const endpoint = `/api/public/surveys/${publicId}/submit`;
  const base = { versionId, anonymous: false, answers: [{ qid: 'note', type: 'text', value: 'hello' }] };
  assert.equal((await owner.post(endpoint).send({ ...base, anonymous: true, clientSubmissionId: 'a' })).body.code, 'VALIDATION_ERROR');
  assert.equal((await owner.post(endpoint).send({ ...base, clientSubmissionId: 'a' })).status, 201);
  assert.equal((await owner.post(endpoint).send({ ...base, clientSubmissionId: 'b' })).status, 201);
  const stored = await db.collection('responses').findOne({ clientSubmissionId: 'a', surveyId: new (require('mongodb').ObjectId)(id) });
  assert.equal(stored.respondentId.toString(), (await db.collection('users').findOne({ username: 'policy-owner' }))._id.toString());
  assert.equal(stored.dedupeKey, null);
  await db.collection('surveys').updateOne({ _id: new (require('mongodb').ObjectId)(id) }, { $set: { deadline: new Date(Date.now() - 1000) } });
  assert.equal((await owner.post(endpoint).send({ ...base, clientSubmissionId: 'c' })).body.code, 'SURVEY_CLOSED');
  assert.equal((await owner.get(`/api/surveys/${id}`)).body.data.status, 'closed');
  assert.equal((await owner.get('/api/surveys/mine')).body.data.find((item) => item._id === id).status, 'closed');
});

test('deadline sweep persists closed status without a request and publishing an expired survey closes it immediately', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'deadline-owner', password: 'good-password' });
  const past = new Date(Date.now() - 60_000).toISOString();
  const created = (await owner.post('/api/surveys').send({ title: 'Already expired', deadline: past })).body.data;
  const base = `/api/surveys/${created._id}`;
  await owner.post(`${base}/questions`).send({ qid: '1', type: 'text', title: 'Question', required: true });
  assert.equal((await owner.post(`${base}/publish`)).status, 201);
  assert.equal((await owner.get(base)).body.data.status, 'closed');

  const active = (await owner.post('/api/surveys').send({ title: 'Expires later' })).body.data;
  const activeBase = `/api/surveys/${active._id}`;
  await owner.post(`${activeBase}/questions`).send({ qid: '1', type: 'text', title: 'Question', required: true });
  await owner.post(`${activeBase}/publish`);
  await db.collection('surveys').updateOne({ _id: new (require('mongodb').ObjectId)(active._id) },
    { $set: { deadline: new Date(past) } });
  const result = await closeExpiredSurveys(db.collection('surveys'));
  assert.equal(result.modifiedCount, 1);
  const stored = await db.collection('surveys').findOne({ _id: new (require('mongodb').ObjectId)(active._id) });
  assert.equal(stored.status, 'closed');
  assert.equal((await owner.get(`/api/public/surveys/${active.publicId}`)).body.code, 'SURVEY_CLOSED');
});

test('concurrent retries with one client submission id store one response', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'concurrent-owner', password: 'good-password' });
  const created = await owner.post('/api/surveys').send({ title: 'Concurrent', allowMultiple: false });
  const id = created.body.data._id;
  await owner.post(`/api/surveys/${id}/questions`).send({ qid: 'note', type: 'text', title: 'Note', required: true });
  const versionId = (await owner.post(`/api/surveys/${id}/publish`)).body.data.versionId;
  const endpoint = `/api/public/surveys/${created.body.data.publicId}/submit`;
  const body = { versionId, clientSubmissionId: 'simultaneous', anonymous: false, answers: [{ qid: 'note', type: 'text', value: 'same' }] };
  const [left, right] = await Promise.all([owner.post(endpoint).send(body), owner.post(endpoint).send(body)]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  assert.equal(left.body.data.id, right.body.data.id);
  assert.equal(await db.collection('responses').countDocuments({ surveyId: new (require('mongodb').ObjectId)(id) }), 1);
});

test('owner closes a published survey while statistics and saved answers remain available', async () => {
  const owner = request.agent(app);
  const outsider = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'close-owner', password: 'good-password' });
  await outsider.post('/api/auth/register').send({ username: 'close-outsider', password: 'good-password' });
  const created = (await owner.post('/api/surveys').send({ title: 'Closable' })).body.data;
  const base = `/api/surveys/${created._id}`;
  assert.equal((await owner.post(`${base}/close`)).body.code, 'SURVEY_LOCKED');
  await owner.post(`${base}/questions`).send({ qid: '1', type: 'text', title: 'Note', required: true });
  const published = await owner.post(`${base}/publish`);
  const publicBase = `/api/public/surveys/${created.publicId}`;
  assert.equal((await outsider.post(`${base}/close`)).body.code, 'NOT_OWNER');
  assert.equal((await outsider.post(`${publicBase}/submit`).send({ versionId: published.body.data.versionId,
    clientSubmissionId: 'before-close', anonymous: false, answers: [{ qid: '1', type: 'text', value: 'saved' }] })).status, 201);
  assert.equal((await owner.post(`${base}/close`)).body.data.status, 'closed');
  assert.equal((await owner.post(`${base}/close`)).body.code, 'SURVEY_LOCKED');
  assert.equal((await outsider.get(publicBase)).body.code, 'SURVEY_CLOSED');
  assert.equal((await outsider.post(`${publicBase}/submit`).send({ versionId: published.body.data.versionId,
    clientSubmissionId: 'after-close', anonymous: false, answers: [{ qid: '1', type: 'text', value: 'no' }] })).body.code, 'SURVEY_CLOSED');
  assert.equal((await owner.get(`${base}/statistics`)).body.data.totalResponses, 1);
});

test('different users can submit the same survey concurrently', async () => {
  const owner = request.agent(app);
  await owner.post('/api/auth/register').send({ username: 'parallel-owner', password: 'good-password' });
  const created = (await owner.post('/api/surveys').send({ title: 'Parallel', allowMultiple: false })).body.data;
  const base = `/api/surveys/${created._id}`;
  await owner.post(`${base}/questions`).send({ qid: '1', type: 'single', title: 'Choice', required: true,
    options: [{ id: 'A', text: 'Yes' }] });
  const versionId = (await owner.post(`${base}/publish`)).body.data.versionId;
  const users = await Promise.all([1, 2, 3].map(async (number) => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ username: `parallel-${number}`, password: 'good-password' });
    return agent;
  }));
  const endpoint = `/api/public/surveys/${created.publicId}/submit`;
  const results = await Promise.all(users.map((agent, index) => agent.post(endpoint).send({
    versionId, clientSubmissionId: `submission-${index}`, anonymous: false,
    answers: [{ qid: '1', type: 'single', value: 'A' }]
  })));
  assert.deepEqual(results.map((result) => result.status), [201, 201, 201]);
  assert.equal(new Set(results.map((result) => result.body.data.id)).size, 3);
  const surveyId = new (require('mongodb').ObjectId)(created._id);
  assert.equal(await db.collection('responses').countDocuments({ surveyId }), 3);
  const stored = await db.collection('responses').find({ surveyId }).toArray();
  assert.equal(new Set(stored.map((item) => item.respondentKey)).size, 3);
  assert.ok(stored.every((item) => item.versionId.toString() === versionId));
  const statistics = (await owner.get(`${base}/statistics`)).body.data;
  assert.equal(statistics.totalResponses, 3);
  assert.deepEqual(statistics.questions[0].counts, [{ optionId: 'A', count: 3 }]);
});

test('registration through published survey, guided response, and statistics works end to end', async () => {
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/auth/register').send({ username: 'flow-user', password: 'good-password' })).status, 201);
  const created = await agent.post('/api/surveys').send({ title: 'Full flow', allowMultiple: false });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  const publicId = created.body.data.publicId;
  const base = `/api/surveys/${id}`;
  assert.equal((await agent.post(`${base}/questions`).send({ qid: 'answer', type: 'number', title: 'Answer', required: true })).status, 201);
  const published = await agent.post(`${base}/publish`);
  assert.equal(published.status, 201);
  const publicSurvey = await agent.get(`/api/public/surveys/${publicId}`);
  assert.equal(publicSurvey.body.data.versionId, published.body.data.versionId);
  const answers = [{ qid: 'answer', type: 'number', value: 42 }];
  const next = await agent.post(`/api/public/surveys/${publicId}/next`).send({
    versionId: published.body.data.versionId, currentQid: 'answer', answers
  });
  assert.equal(next.body.data.nextQid, null);
  const submitted = await agent.post(`/api/public/surveys/${publicId}/submit`).send({
    versionId: published.body.data.versionId, clientSubmissionId: 'full-flow', anonymous: false, answers
  });
  assert.equal(submitted.status, 201);
  const statistics = await agent.get(`${base}/statistics`);
  assert.equal(statistics.body.data.totalResponses, 1);
  assert.deepEqual(statistics.body.data.questions[0], {
    qid: 'answer', type: 'number', title: 'Answer', count: 1, avg: 42, min: 42, max: 42, values: [42]
  });
});
