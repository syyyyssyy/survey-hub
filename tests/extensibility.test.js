'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const request = require('supertest');
const { MongoClient, ObjectId } = require('mongodb');
const { createApp } = require('../src/app');

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = `survey_extensibility_test_${new ObjectId()}`;
let client;
let db;

test.before(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(databaseName);
  const databaseUri = `${uri.replace(/\/$/, '')}/${databaseName}`;
  const initialized = spawnSync('mongosh', [databaseUri, '--quiet', '--file', path.join(__dirname, '..', 'database', 'init-mongodb.js')], {
    encoding: 'utf8', timeout: 15000
  });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.error?.message);
});

test.after(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

test('configuration extension preserves old validation, jumps, and statistics', async () => {
  const app = createApp(db, { sessionSecret: 'extensibility-test-secret-at-least-32-characters' });
  const owner = request.agent(app);
  const first = request.agent(app);
  const second = request.agent(app);
  for (const [agent, username] of [[owner, 'ext-owner'], [first, 'ext-first'], [second, 'ext-second']]) {
    assert.equal((await agent.post('/api/auth/register').send({ username, password: 'good-password' })).status, 201);
  }

  const created = (await owner.post('/api/surveys').send({ title: 'Range extension', allowMultiple: true })).body.data;
  const base = `/api/surveys/${created._id}`;
  const publicBase = `/api/public/surveys/${created.publicId}`;
  const questions = (max, threshold) => [
    { qid: '1', type: 'number', title: 'Age', required: true,
      validation: { min: 0, max, integer: true },
      jumpRules: [{ id: 'older', when: { op: 'gt', value: threshold }, targetQid: '3' }] },
    { qid: '2', type: 'text', title: 'Category', required: false },
    { qid: '3', type: 'text', title: 'Finish', required: true }
  ];
  const v1Questions = questions(120, 100);
  assert.equal((await owner.put(`${base}/questions`).send(v1Questions)).status, 200);
  const v1 = (await owner.post(`${base}/publish`)).body.data.versionId;
  const answer = (age, includeMiddle = false) => [
    { qid: '1', type: 'number', value: age },
    ...(includeMiddle ? [{ qid: '2', type: 'text', value: 'middle' }] : []),
    { qid: '3', type: 'text', value: 'done' }
  ];
  const submit = (agent, versionId, key, age, includeMiddle = false) =>
    agent.post(`${publicBase}/submit`).send({ versionId, clientSubmissionId: key,
      anonymous: false, answers: answer(age, includeMiddle) });

  assert.equal((await submit(first, v1, 'old-first', 110)).status, 201);
  assert.equal((await submit(first, v1, 'old-invalid', 121)).body.code, 'VALIDATION_ERROR');

  assert.equal((await owner.get(`${base}/draft`)).status, 200);
  const v2Questions = questions(150, 130);
  assert.equal((await owner.put(`${base}/questions`).send(v2Questions)).status, 200);
  const v2 = (await owner.post(`${base}/publish`)).body.data.versionId;
  assert.notEqual(v1, v2);
  assert.equal((await second.get(publicBase)).body.data.versionId, v2);

  assert.equal((await second.post(`${publicBase}/next`).send({
    versionId: v2, currentQid: '1', answers: answer(121, true).slice(0, 1)
  })).body.data.nextQid, '2');
  assert.equal((await second.post(`${publicBase}/next`).send({
    versionId: v2, currentQid: '1', answers: answer(140).slice(0, 1)
  })).body.data.nextQid, '3');
  assert.equal((await second.post(`${publicBase}/next`).send({
    versionId: v1, currentQid: '1', answers: answer(110).slice(0, 1)
  })).body.data.nextQid, '3');
  assert.equal((await submit(second, v2, 'new-valid', 121, true)).status, 201);
  assert.equal((await submit(second, v2, 'new-invalid', 151, true)).body.code, 'VALIDATION_ERROR');
  assert.equal((await submit(second, v1, 'old-after-publish', 115)).status, 201);
  assert.equal((await submit(second, v1, 'old-still-invalid', 121)).body.code, 'VALIDATION_ERROR');

  const oldSnapshot = await db.collection('survey_versions').findOne({ _id: new ObjectId(v1) });
  assert.deepEqual(oldSnapshot.questions, v1Questions);
  const survey = await db.collection('surveys').findOne({ _id: new ObjectId(created._id) });
  assert.deepEqual(survey.draftQuestions, v2Questions);
  const oldStats = (await owner.get(`${base}/statistics?versionId=${v1}`)).body.data;
  const newStats = (await owner.get(`${base}/statistics`)).body.data;
  assert.equal(oldStats.totalResponses, 2);
  assert.equal(oldStats.questions[0].avg, 112.5);
  assert.equal(newStats.totalResponses, 1);
  assert.equal(newStats.questions[0].avg, 121);
  assert.equal(await db.collection('responses').countDocuments({ versionId: new ObjectId(v1) }), 2);
  assert.equal(await db.collection('responses').countDocuments({ versionId: new ObjectId(v2) }), 1);
});

test('rating question extends the existing versioned workflow', async () => {
  const app = createApp(db, { sessionSecret: 'extensibility-test-secret-at-least-32-characters' });
  const owner = request.agent(app);
  const respondent = request.agent(app);
  assert.equal((await owner.post('/api/auth/register').send({
    username: 'rating-owner', password: 'good-password'
  })).status, 201);
  assert.equal((await respondent.post('/api/auth/register').send({
    username: 'rating-respondent', password: 'good-password'
  })).status, 201);

  const created = (await owner.post('/api/surveys').send({ title: 'Rating extension', allowMultiple: true })).body.data;
  const base = `/api/surveys/${created._id}`;
  const publicBase = `/api/public/surveys/${created.publicId}`;
  const oldQuestions = [
    { qid: '1', type: 'number', title: 'Old score', required: true,
      validation: { min: 0, max: 100, integer: true } },
    { qid: '2', type: 'text', title: 'Comment', required: false }
  ];
  assert.equal((await owner.put(`${base}/questions`).send(oldQuestions)).status, 200);
  const v1 = (await owner.post(`${base}/publish`)).body.data.versionId;
  const submission = (versionId, key, answers) => ({
    versionId, clientSubmissionId: key, anonymous: false, answers
  });
  assert.equal((await respondent.post(`${publicBase}/submit`).send(submission(v1, 'old-score', [
    { qid: '1', type: 'number', value: 80 }
  ]))).status, 201);

  assert.equal((await owner.get(`${base}/draft`)).status, 200);
  const ratingQuestions = [
    { qid: '1', type: 'rating', title: 'Rate from 1 to 5', required: true,
      validation: { min: 1, max: 5, integer: true },
      jumpRules: [{ id: 'high', when: { op: 'gt', value: 3 }, targetQid: '3' }] },
    { qid: '2', type: 'text', title: 'Explain low rating', required: true },
    { qid: '3', type: 'text', title: 'Finish', required: false }
  ];
  for (const validation of [
    { min: 1, max: 5 },
    { min: 1, max: 11, integer: true },
    { min: 5, max: 5, integer: true }
  ]) {
    const invalid = await owner.put(`${base}/questions`).send([
      { ...ratingQuestions[0], validation }, ...ratingQuestions.slice(1)
    ]);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'VALIDATION_ERROR');
  }
  assert.equal((await owner.put(`${base}/questions`).send(ratingQuestions)).status, 200);
  await assert.rejects(
    db.collection('surveys').updateOne({ _id: new ObjectId(created._id) },
      { $set: { 'draftQuestions.0.validation': { min: 1, max: 5 } } }),
    (error) => error.code === 121
  );
  const published = await owner.post(`${base}/publish`);
  assert.equal(published.status, 201);
  const v2 = published.body.data.versionId;
  assert.equal((await respondent.get(publicBase)).body.data.questions[0].type, 'rating');

  const current = (value) => [{ qid: '1', type: 'rating', value }];
  assert.equal((await respondent.post(`${publicBase}/next`).send({
    versionId: v2, currentQid: '1', answers: current(2)
  })).body.data.nextQid, '2');
  assert.equal((await respondent.post(`${publicBase}/next`).send({
    versionId: v2, currentQid: '1', answers: current(4)
  })).body.data.nextQid, '3');
  for (const invalid of [0, 6, 2.5]) {
    assert.equal((await respondent.post(`${publicBase}/submit`).send(submission(v2, `invalid-${invalid}`, current(invalid)))).body.code,
      'VALIDATION_ERROR');
  }
  assert.equal((await respondent.post(`${publicBase}/submit`).send(submission(v2, 'rating-4', current(4)))).status, 201);
  assert.equal((await respondent.post(`${publicBase}/submit`).send(submission(v1, 'old-after-rating', [
    { qid: '1', type: 'number', value: 90 }
  ]))).status, 201);

  const oldSnapshot = await db.collection('survey_versions').findOne({ _id: new ObjectId(v1) });
  assert.deepEqual(oldSnapshot.questions, oldQuestions);
  const oldStats = (await owner.get(`${base}/statistics?versionId=${v1}`)).body.data;
  const ratingStats = (await owner.get(`${base}/statistics`)).body.data;
  assert.equal(oldStats.totalResponses, 2);
  assert.equal(oldStats.questions[0].avg, 85);
  assert.equal(ratingStats.totalResponses, 1);
  assert.deepEqual(ratingStats.questions[0], {
    qid: '1', type: 'rating', title: 'Rate from 1 to 5', count: 1,
    avg: 4, min: 4, max: 4, values: [4]
  });
});
