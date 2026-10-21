'use strict';

const express = require('express');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { z, ZodError } = require('zod');
const { credentials, survey: surveySchema, question: questionSchema, submission: submissionSchema, nextStep: nextStepSchema } = require('./schemas');
const { validateSurveyLogic } = require('./survey-logic');
const { getStatistics } = require('./statistics');
const { closeExpiredSurveys } = require('./survey-status');
const { replayPath, validateAnswer, resolveNextQuestion } = require('./rule-engine');

function apiError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function createApp(db, { sessionSecret = process.env.SESSION_SECRET } = {}) {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  const app = express();
  const users = db.collection('users');
  const surveys = db.collection('surveys');
  const versions = db.collection('survey_versions');
  const responses = db.collection('responses');
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const sign = (userId) => {
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
    const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  };
  const currentUserId = (request) => {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('session='));
    const token = cookie?.slice('session='.length);
    if (!token) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.exp > Date.now() && ObjectId.isValid(data.sub) ? new ObjectId(data.sub) : null;
    } catch {
      return null;
    }
  };
  const requireLogin = (request, _response, next) => {
    request.userId = currentUserId(request);
    if (!request.userId) return next(apiError('LOGIN_REQUIRED', 401, 'Login required'));
    next();
  };
  const setSession = (response, userId) => {
    response.cookie('session', sign(userId.toString()), {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000
    });
  };
  const ok = (response, data, status = 200) => response.status(status).json({ code: 0, message: 'ok', data });
  const objectId = (value) => {
    if (typeof value !== 'string' || !ObjectId.isValid(value) || new ObjectId(value).toString() !== value.toLowerCase()) {
      throw apiError('VALIDATION_ERROR', 400, 'Invalid id');
    }
    return new ObjectId(value);
  };
  const ownedSurvey = async (request) => {
    const id = objectId(request.params.id);
    await closeExpiredSurveys(surveys, { _id: id, ownerId: request.userId });
    const record = await surveys.findOne({ _id: id });
    if (!record) throw apiError('NOT_FOUND', 404, 'Survey not found');
    if (!record.ownerId.equals(request.userId)) throw apiError('NOT_OWNER', 403, 'Not survey owner');
    return record;
  };
  const editableSurvey = async (request) => {
    const record = await ownedSurvey(request);
    if (record.status !== 'draft' && !(record.status === 'published' &&
        record.draftBaseVersionId?.equals(record.publishedVersionId))) {
      throw apiError('SURVEY_LOCKED', 409, 'Open an editing draft first');
    }
    return record;
  };
  const editableFilter = (record) => ({
    _id: record._id, ownerId: record.ownerId, status: record.status,
    ...(record.status === 'published' ? { draftBaseVersionId: record.publishedVersionId,
      publishedVersionId: record.publishedVersionId } : {})
  });

  app.post('/api/auth/register', async (request, response) => {
    const input = credentials.parse(request.body);
    const now = new Date();
    const user = { username: input.username, passwordHash: await bcrypt.hash(input.password, 12), createdAt: now, updatedAt: now };
    const result = await users.insertOne(user);
    setSession(response, result.insertedId);
    ok(response, { id: result.insertedId.toString(), username: user.username }, 201);
  });
  app.post('/api/auth/login', async (request, response) => {
    const input = credentials.parse(request.body);
    const user = await users.findOne({ username: input.username });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw apiError('INVALID_CREDENTIALS', 401, 'Invalid username or password');
    }
    setSession(response, user._id);
    ok(response, { id: user._id.toString(), username: user.username });
  });
  app.post('/api/auth/logout', (_request, response) => {
    response.clearCookie('session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    ok(response, {});
  });
  app.get('/api/auth/me', requireLogin, async (request, response) => {
    const user = await users.findOne({ _id: request.userId }, { projection: { username: 1 } });
    if (!user) throw apiError('LOGIN_REQUIRED', 401, 'Login required');
    ok(response, { id: user._id.toString(), username: user.username });
  });

  app.post('/api/surveys', requireLogin, async (request, response) => {
    const input = surveySchema.parse(request.body);
    const now = new Date();
    const record = {
      ownerId: request.userId,
      publicId: randomBytes(9).toString('base64url'),
      title: input.title,
      description: input.description,
      allowAnonymous: input.allowAnonymous,
      allowMultiple: input.allowMultiple,
      status: 'draft',
      deadline: input.deadline ? new Date(input.deadline) : null,
      draftQuestions: [],
      draftBaseVersionId: null,
      publishedVersionId: null,
      createdAt: now,
      updatedAt: now
    };
    const result = await surveys.insertOne(record);
    ok(response, { ...record, _id: result.insertedId }, 201);
  });
  app.get('/api/surveys/mine', requireLogin, async (request, response) => {
    await closeExpiredSurveys(surveys, { ownerId: request.userId });
    const records = await surveys.find({ ownerId: request.userId }).sort({ createdAt: -1, _id: -1 }).toArray();
    ok(response, records);
  });
  app.get('/api/surveys/:id', requireLogin, async (request, response) => {
    ok(response, await ownedSurvey(request));
  });
  app.get('/api/surveys/:id/draft', requireLogin, async (request, response) => {
    const record = await ownedSurvey(request);
    if (record.status === 'draft' || record.draftBaseVersionId?.equals(record.publishedVersionId)) {
      return ok(response, record);
    }
    if (record.status !== 'published') throw apiError('SURVEY_LOCKED', 409, 'Survey is not published');
    const version = await versions.findOne({ _id: record.publishedVersionId, surveyId: record._id });
    if (!version) throw apiError('INVALID_SURVEY_LOGIC', 500, 'Published version missing');
    const updated = await surveys.findOneAndUpdate(
      { _id: record._id, ownerId: request.userId, status: 'published',
        publishedVersionId: version._id, draftBaseVersionId: null },
      { $set: { draftQuestions: structuredClone(version.questions),
        draftBaseVersionId: version._id, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (updated) return ok(response, updated);
    const current = await ownedSurvey(request);
    if (current.draftBaseVersionId?.equals(current.publishedVersionId)) return ok(response, current);
    throw apiError('CONFLICT', 409, 'Survey changed while opening draft');
  });
  app.patch('/api/surveys/:id', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    const changes = surveySchema.partial().refine((value) => Object.keys(value).length > 0).parse(request.body);
    if (changes.deadline !== undefined) changes.deadline = changes.deadline ? new Date(changes.deadline) : null;
    const result = await surveys.findOneAndUpdate(
      editableFilter(record),
      { $set: { ...changes, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) throw apiError('CONFLICT', 409, 'Survey changed');
    ok(response, result);
  });
  app.post('/api/surveys/:id/questions', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    const question = questionSchema.parse(request.body);
    const result = await surveys.updateOne(
      { ...editableFilter(record), 'draftQuestions.qid': { $ne: question.qid } },
      { $push: { draftQuestions: question }, $set: { updatedAt: new Date() } }
    );
    if (!result.modifiedCount) throw apiError('CONFLICT', 409, 'Question already exists or survey changed');
    ok(response, question, 201);
  });
  app.put('/api/surveys/:id/questions', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    const questions = z.array(questionSchema).parse(request.body);
    const ids = questions.map((item) => item.qid);
    if (ids.length !== new Set(ids).size) throw apiError('VALIDATION_ERROR', 400, 'Duplicate question id');
    const result = await surveys.updateOne(
      { ...editableFilter(record), updatedAt: record.updatedAt },
      { $set: { draftQuestions: questions, updatedAt: new Date() } }
    );
    if (!result.modifiedCount) throw apiError('CONFLICT', 409, 'Survey changed');
    ok(response, questions);
  });
  app.patch('/api/surveys/:id/questions/:qid', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    const previous = record.draftQuestions.find((item) => item.qid === request.params.qid);
    if (!previous) throw apiError('NOT_FOUND', 404, 'Question not found');
    if (request.body?.qid !== undefined && request.body.qid !== request.params.qid) {
      throw apiError('VALIDATION_ERROR', 400, 'Question id cannot change');
    }
    const question = questionSchema.parse({ ...previous, ...request.body });
    const result = await surveys.updateOne(
      { ...editableFilter(record), 'draftQuestions.qid': question.qid },
      { $set: { 'draftQuestions.$': question, updatedAt: new Date() } }
    );
    if (!result.modifiedCount) throw apiError('CONFLICT', 409, 'Survey changed');
    ok(response, question);
  });
  app.delete('/api/surveys/:id/questions/:qid', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    if (!record.draftQuestions.some((item) => item.qid === request.params.qid)) {
      throw apiError('NOT_FOUND', 404, 'Question not found');
    }
    const result = await surveys.updateOne(
      { ...editableFilter(record), 'draftQuestions.qid': request.params.qid },
      { $pull: { draftQuestions: { qid: request.params.qid } }, $set: { updatedAt: new Date() } }
    );
    if (!result.modifiedCount) throw apiError('CONFLICT', 409, 'Survey changed');
    ok(response, {});
  });

  app.post('/api/surveys/:id/publish', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    validateSurveyLogic(record.draftQuestions);
    const previous = record.publishedVersionId
      ? await versions.findOne({ _id: record.publishedVersionId, surveyId: record._id }) : null;
    if (record.publishedVersionId && !previous) {
      throw apiError('INVALID_SURVEY_LOGIC', 500, 'Published version missing');
    }
    const now = new Date();
    const snapshot = {
      surveyId: record._id,
      version: (previous?.version || 0) + 1,
      questions: structuredClone(record.draftQuestions),
      publishedAt: now,
      publishedBy: request.userId
    };
    let inserted;
    try {
      inserted = await versions.insertOne(snapshot);
      const updated = await surveys.updateOne(
        { ...editableFilter(record), updatedAt: record.updatedAt, draftQuestions: record.draftQuestions },
        { $set: { status: record.deadline && record.deadline <= now ? 'closed' : 'published',
          publishedVersionId: inserted.insertedId,
          draftBaseVersionId: null, updatedAt: now } }
      );
      if (!updated.modifiedCount) throw apiError('CONFLICT', 409, 'Survey changed during publication');
    } catch (error) {
      if (inserted) await versions.deleteOne({ _id: inserted.insertedId });
      if (error.code === 11000) throw apiError('CONFLICT', 409, 'Survey publication already in progress');
      throw error;
    }
    ok(response, { versionId: inserted.insertedId.toString(), version: snapshot.version }, 201);
  });
  app.post('/api/surveys/:id/close', requireLogin, async (request, response) => {
    const record = await ownedSurvey(request);
    if (record.status !== 'published') throw apiError('SURVEY_LOCKED', 409, 'Only a published survey can be closed');
    const updated = await surveys.findOneAndUpdate(
      { _id: record._id, ownerId: request.userId, status: 'published' },
      { $set: { status: 'closed', draftBaseVersionId: null, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!updated) throw apiError('CONFLICT', 409, 'Survey changed');
    ok(response, updated);
  });

  const publishedSurvey = async (publicId) => {
    await closeExpiredSurveys(surveys, { publicId });
    const record = await surveys.findOne({ publicId });
    if (!record || record.status === 'draft') throw apiError('NOT_FOUND', 404, 'Published survey not found');
    if (record.status !== 'published') throw apiError('SURVEY_CLOSED', 409, 'Survey is closed');
    return record;
  };
  app.get('/api/public/surveys/:publicId', requireLogin, async (request, response) => {
    const record = await publishedSurvey(request.params.publicId);
    const version = await versions.findOne({ _id: record.publishedVersionId, surveyId: record._id });
    if (!version) throw apiError('INVALID_SURVEY_LOGIC', 500, 'Published version missing');
    ok(response, {
      publicId: record.publicId,
      title: record.title,
      description: record.description,
      allowAnonymous: record.allowAnonymous,
      allowMultiple: record.allowMultiple,
      deadline: record.deadline,
      versionId: version._id.toString(),
      questions: version.questions
    });
  });
  app.post('/api/public/surveys/:publicId/next', requireLogin, async (request, response) => {
    const input = nextStepSchema.parse(request.body);
    const record = await publishedSurvey(request.params.publicId);
    const version = await versions.findOne({ _id: objectId(input.versionId), surveyId: record._id });
    if (!version) throw apiError('VERSION_EXPIRED', 409, 'Survey version is invalid');
    const submitted = new Map();
    for (const answer of input.answers) {
      if (submitted.has(answer.qid)) throw apiError('VALIDATION_ERROR', 400, 'Duplicate answer');
      submitted.set(answer.qid, answer);
    }
    const visited = new Set();
    let qid = version.questions[0]?.qid ?? null;
    while (qid !== input.currentQid) {
      if (!qid || visited.has(qid)) throw apiError('JUMP_PATH_MISMATCH', 400, 'Question is outside path');
      visited.add(qid);
      const question = version.questions.find((item) => item.qid === qid);
      const answer = submitted.get(qid);
      if (!answer && question.required) throw apiError('JUMP_PATH_MISMATCH', 400, 'Question is outside submitted path');
      validateAnswer(question, answer);
      qid = resolveNextQuestion(version.questions, qid, answer);
    }
    const question = version.questions.find((item) => item.qid === qid);
    if (!question) throw apiError('JUMP_PATH_MISMATCH', 400, 'Question is outside path');
    for (const answerQid of submitted.keys()) {
      if (!visited.has(answerQid) && answerQid !== qid) {
        throw apiError('JUMP_PATH_MISMATCH', 400, 'Answer is outside path');
      }
    }
    const currentAnswer = submitted.get(qid);
    validateAnswer(question, currentAnswer);
    ok(response, { nextQid: resolveNextQuestion(version.questions, qid, currentAnswer) });
  });
  app.post('/api/public/surveys/:publicId/submit', requireLogin, async (request, response) => {
    const input = submissionSchema.parse(request.body);
    await closeExpiredSurveys(surveys, { publicId: request.params.publicId });
    const record = await surveys.findOne({ publicId: request.params.publicId });
    if (!record || record.status === 'draft') throw apiError('NOT_FOUND', 404, 'Published survey not found');
    const respondentKey = createHmac('sha256', sessionSecret)
      .update(`respondent:${request.userId.toString()}:${record._id.toString()}`).digest('hex');
    const submissionKey = {
      surveyId: record._id,
      respondentKey,
      clientSubmissionId: input.clientSubmissionId
    };
    const resultData = (item) => ({
      id: item._id.toString(),
      versionId: item.versionId.toString(),
      path: item.path,
      submittedAt: item.submittedAt
    });
    const receiptProjection = { _id: 1, versionId: 1, path: 1, submittedAt: 1 };
    const previous = await responses.findOne(submissionKey, { projection: receiptProjection });
    if (previous) return ok(response, resultData(previous));
    if (record.status !== 'published') throw apiError('SURVEY_CLOSED', 409, 'Survey is closed');
    if (input.anonymous && !record.allowAnonymous) {
      throw apiError('VALIDATION_ERROR', 400, 'Anonymous responses are not allowed');
    }
    const version = await versions.findOne({ _id: objectId(input.versionId), surveyId: record._id });
    if (!version) throw apiError('VERSION_EXPIRED', 409, 'Survey version is invalid');
    const path = replayPath(version.questions, input.answers);
    const answerRecord = {
      ...submissionKey,
      versionId: version._id,
      respondentId: input.anonymous ? null : request.userId,
      dedupeKey: record.allowMultiple ? null : `${record._id.toString()}:${respondentKey}`,
      anonymous: input.anonymous,
      answers: input.answers,
      path,
      submittedAt: new Date()
    };
    try {
      const inserted = await responses.insertOne(answerRecord);
      ok(response, resultData({ ...answerRecord, _id: inserted.insertedId }), 201);
    } catch (error) {
      if (error.code !== 11000) throw error;
      const concurrent = await responses.findOne(submissionKey, { projection: receiptProjection });
      if (concurrent) return ok(response, resultData(concurrent));
      throw apiError('DUPLICATE_SUBMISSION', 409, 'Response already submitted');
    }
  });

  const statisticsVersion = async (request) => {
    const record = await ownedSurvey(request);
    const versionId = request.query.versionId === undefined
      ? record.publishedVersionId : objectId(request.query.versionId);
    if (!versionId) throw apiError('NOT_FOUND', 404, 'Published version not found');
    const version = await versions.findOne({ _id: versionId, surveyId: record._id });
    if (!version) throw apiError('NOT_FOUND', 404, 'Survey version not found');
    return { record, version };
  };
  app.get('/api/surveys/:id/versions', requireLogin, async (request, response) => {
    const record = await ownedSurvey(request);
    const items = await versions.find({ surveyId: record._id })
      .sort({ version: -1 }).project({ version: 1, publishedAt: 1 }).toArray();
    ok(response, items.map((item) => ({ versionId: item._id.toString(),
      version: item.version, publishedAt: item.publishedAt })));
  });
  app.get('/api/surveys/:id/statistics', requireLogin, async (request, response) => {
    const { record, version } = await statisticsVersion(request);
    ok(response, await getStatistics(responses, record._id, version));
  });
  app.get('/api/surveys/:id/statistics/:qid', requireLogin, async (request, response) => {
    const { record, version } = await statisticsVersion(request);
    if (!version.questions.some((question) => question.qid === request.params.qid)) {
      throw apiError('NOT_FOUND', 404, 'Question not found in version');
    }
    ok(response, await getStatistics(responses, record._id, version, request.params.qid));
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof ZodError) {
      return response.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid input', data: { issues: error.issues } });
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return response.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON', data: {} });
    }
    if (error.code === 11000) {
      return response.status(409).json({ code: 'ALREADY_EXISTS', message: 'Value already exists', data: {} });
    }
    const status = error.status || (['VALIDATION_ERROR', 'JUMP_PATH_MISMATCH', 'INVALID_SURVEY_LOGIC'].includes(error.code) ? 400 : 500);
    response.status(status).json({ code: error.code || 'INTERNAL_ERROR', message: status === 500 ? 'Internal server error' : error.message, data: {} });
  });
  return app;
}

module.exports = { createApp };
