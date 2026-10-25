'use strict';

const { ObjectId } = require('mongodb');
const { z } = require('zod');
const { createHash, randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { libraryContent, question: questionSchema } = require('./schemas');
const { getLibraryStatistics } = require('./statistics');
const { validateSurveyLogic } = require('./survey-logic');

const contentOf = ({ type, title, required, options, validation }) => ({
  type, title, required, ...(options?.length && { options }),
  ...(validation && Object.keys(validation).length && { validation })
});
const sameContent = (a, b) => isDeepStrictEqual(contentOf(a), contentOf(b));
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const available = { archivedAt: { $exists: false } };

function mountLibraryRoutes(app, db, { requireLogin, objectId, apiError, ok, editableSurvey, editableFilter }) {
  const banks = db.collection('question_banks');
  const library = db.collection('library_questions');
  const revisions = db.collection('question_versions');
  const surveys = db.collection('surveys');
  const versions = db.collection('survey_versions');
  const responses = db.collection('responses');
  const fail = (code, status, message) => { throw apiError(code, status, message); };
  const id = (value) => objectId(value);
  const bankOwned = async (request) => {
    const bank = await banks.findOne({ _id: id(request.params.bankId) });
    if (!bank) fail('NOT_FOUND', 404, 'Question bank not found');
    if (!bank.ownerId.equals(request.userId)) fail('NOT_OWNER', 403, 'Not question bank owner');
    return bank;
  };
  const accessible = async (request) => {
    const item = await library.findOne({ _id: id(request.params.questionId), ...available });
    if (!item) fail('NOT_FOUND', 404, 'Library question not found');
    if (!item.ownerId.equals(request.userId)) {
      fail('NOT_OWNER', 403, 'Library question is private');
    }
    return item;
  };
  const contentFromSurvey = async (request, surveyId, qid) => {
    const survey = await surveys.findOne({ _id: id(surveyId) });
    if (!survey) fail('NOT_FOUND', 404, 'Survey not found');
    if (!survey.ownerId.equals(request.userId)) fail('NOT_OWNER', 403, 'Not survey owner');
    const source = survey.draftQuestions.find((item) => item.qid === qid);
    if (!source) fail('NOT_FOUND', 404, 'Question not found');
    const { type, title, required, options, validation } = source;
    if (source.libraryQuestionId) fail('CONFLICT', 409, 'Question is already in the library');
    if (survey.status !== 'draft' && !(survey.status === 'published' &&
        survey.draftBaseVersionId?.equals(survey.publishedVersionId))) {
      fail('SURVEY_LOCKED', 409, 'Open an editing draft first');
    }
    return { survey, source, content: libraryContent.parse({
      type, title, required, ...(options && { options }), ...(validation && { validation })
    }) };
  };
  const createVersion = async (item, content, sourceVersionId, userId) => {
    const latest = await revisions.findOne({ questionId: item._id }, { sort: { version: -1 } });
    if (!latest) fail('CONFLICT', 409, 'Current question version is missing');
    const now = new Date();
    const revision = { questionId: item._id, version: latest.version + 1,
      content, contentRevision: 1, sourceVersionId, createdBy: userId, createdAt: now };
    const inserted = await revisions.insertOne(revision);
    const result = await library.updateOne(
      { _id: item._id, ownerId: userId, currentVersionId: item.currentVersionId },
      { $set: { currentVersionId: inserted.insertedId, updatedAt: now } }
    );
    if (!result.modifiedCount) {
      await revisions.deleteOne({ _id: inserted.insertedId });
      fail('CONFLICT', 409, 'Question changed while creating version');
    }
    return { ...revision, _id: inserted.insertedId };
  };
  const replaceLinked = (questions, item, version, content, revision, snapshotId = null) => {
    let changed = false;
    const updated = questions.map((question) => {
      const direct = question.libraryQuestionId === item._id.toString() &&
        question.questionVersionId === version._id.toString();
      const mother = snapshotId && (item.originRefs || []).some((ref) =>
        ref.surveyVersionId.equals(snapshotId) && ref.qid === question.qid &&
        ref.questionVersionId.equals(version._id));
      if (!direct && !mother) return question;
      changed = true;
      return questionSchema.parse({ qid: question.qid, ...structuredClone(content),
        jumpRules: question.jumpRules || [], libraryQuestionId: item._id.toString(),
        questionVersionId: version._id.toString(), contentRevision: revision });
    });
    return { changed, questions: updated };
  };

  app.post('/api/question-banks', requireLogin, async (request, response) => {
    const { name } = z.strictObject({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    const now = new Date();
    const bank = { ownerId: request.userId, name, createdAt: now, updatedAt: now };
    const result = await banks.insertOne(bank);
    ok(response, { ...bank, _id: result.insertedId }, 201);
  });
  app.get('/api/question-banks', requireLogin, async (request, response) => {
    ok(response, await banks.find({ ownerId: request.userId }).sort({ createdAt: -1 }).toArray());
  });
  app.patch('/api/question-banks/:bankId', requireLogin, async (request, response) => {
    const bank = await bankOwned(request);
    const { name } = z.strictObject({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    const updated = await banks.findOneAndUpdate({ _id: bank._id, ownerId: request.userId },
      { $set: { name, updatedAt: new Date() } }, { returnDocument: 'after' });
    ok(response, updated);
  });
  app.delete('/api/question-banks/:bankId', requireLogin, async (request, response) => {
    const bank = await bankOwned(request);
    if (await library.countDocuments({ bankId: bank._id })) fail('CONFLICT', 409, 'Move or remove questions first');
    await banks.deleteOne({ _id: bank._id, ownerId: request.userId });
    ok(response, {});
  });
  const saveQuestion = async (request, response, bankId) => {
    const input = z.strictObject({ question: libraryContent.optional(),
      surveyId: z.string().optional(), qid: z.string().optional() }).parse(request.body);
    if (!!input.question === !!input.surveyId || (!!input.surveyId !== !!input.qid)) {
      fail('VALIDATION_ERROR', 400, 'Provide a question or surveyId and qid');
    }
    const origin = input.surveyId ? await contentFromSurvey(request, input.surveyId, input.qid) : null;
    const content = input.question || origin.content;
    const now = new Date();
    const itemId = new ObjectId();
    const versionId = new ObjectId();
    const snapshots = origin ? await versions.find({ surveyId: origin.survey._id }).toArray() : [];
    const originRefs = snapshots.flatMap((snapshot) => snapshot.questions
      .filter((question) => question.qid === input.qid && !question.libraryQuestionId && sameContent(question, content))
      .map(() => ({ surveyVersionId: snapshot._id, qid: input.qid, questionVersionId: versionId })));
    const item = { _id: itemId, bankId, ownerId: request.userId,
      sharedWith: [], currentVersionId: versionId, originRefs, createdAt: now, updatedAt: now };
    const version = { _id: versionId, questionId: itemId, version: 1, content,
      contentRevision: 1, sourceVersionId: null, createdBy: request.userId, createdAt: now };
    await revisions.insertOne(version);
    try {
      await library.insertOne(item);
      if (origin) {
        const questions = origin.survey.draftQuestions.map((question) => question.qid === input.qid
          ? { ...question, libraryQuestionId: itemId.toString(), questionVersionId: versionId.toString(),
            contentRevision: 1 } : question);
        const updated = await surveys.updateOne({ ...editableFilter(origin.survey),
          updatedAt: origin.survey.updatedAt, draftQuestions: origin.survey.draftQuestions },
        { $set: { draftQuestions: questions, updatedAt: now } });
        if (!updated.modifiedCount) fail('CONFLICT', 409, 'Source survey changed');
      }
    } catch (error) {
      await library.deleteOne({ _id: itemId });
      await revisions.deleteOne({ _id: versionId });
      throw error;
    }
    ok(response, { ...item, currentVersion: version }, 201);
  };
  app.post('/api/question-banks/:bankId/questions', requireLogin, async (request, response) => {
    const bank = await bankOwned(request);
    await saveQuestion(request, response, bank._id);
  });
  app.post('/api/library-questions', requireLogin, async (request, response) => {
    await saveQuestion(request, response, null);
  });
  app.get('/api/question-banks/:bankId/questions', requireLogin, async (request, response) => {
    const bank = await bankOwned(request);
    const items = await library.find({ bankId: bank._id, ownerId: request.userId,
      ...available }).sort({ createdAt: -1 }).toArray();
    const current = await revisions.find({ _id: { $in: items.map((item) => item.currentVersionId) } }).toArray();
    const byId = new Map(current.map((item) => [item._id.toString(), item]));
    ok(response, items.map((item) => ({ ...item, currentVersion: byId.get(item.currentVersionId.toString()) })));
  });
  app.get('/api/library-questions', requireLogin, async (request, response) => {
    const items = await library.find({ ownerId: request.userId, ...available })
      .sort({ createdAt: -1 }).toArray();
    const current = await revisions.find({ _id: { $in: items.map((item) => item.currentVersionId) } }).toArray();
    const byId = new Map(current.map((item) => [item._id.toString(), item]));
    ok(response, items.map((item) => ({ ...item, currentVersion: byId.get(item.currentVersionId.toString()) })));
  });
  app.post('/api/library-questions/batch', requireLogin, async (request, response) => {
    const input = z.strictObject({ ids: z.array(z.string()).min(1),
      action: z.enum(['move', 'archive']), bankId: z.string().nullable().optional() }).parse(request.body);
    const ids = input.ids.map(id);
    if (new Set(input.ids).size !== ids.length) fail('VALIDATION_ERROR', 400, 'Duplicate question id');
    const owned = await library.find({ _id: { $in: ids }, ownerId: request.userId, ...available }).toArray();
    if (owned.length !== ids.length) fail('NOT_OWNER', 403, 'Question is missing or not owned');
    let bankId = null;
    if (input.action === 'move' && input.bankId !== null && input.bankId !== undefined) {
      const bank = await banks.findOne({ _id: id(input.bankId), ownerId: request.userId });
      if (!bank) fail('NOT_OWNER', 403, 'Target bank is not yours');
      bankId = bank._id;
    }
    const now = new Date();
    const change = input.action === 'archive'
      ? { $set: { archivedAt: now, bankId: null, updatedAt: now }, $unset: { shareTokenHash: '' } }
      : { $set: { bankId, updatedAt: now } };
    const result = await library.updateMany({ _id: { $in: ids }, ownerId: request.userId, ...available }, change);
    if (result.modifiedCount !== ids.length) fail('CONFLICT', 409, 'Questions changed during batch operation');
    ok(response, { count: result.modifiedCount });
  });
  app.get('/api/library-questions/:questionId/versions', requireLogin, async (request, response) => {
    const item = await accessible(request);
    ok(response, await revisions.find({ questionId: item._id }).sort({ version: -1 }).toArray());
  });
  app.post('/api/library-questions/:questionId/versions', requireLogin, async (request, response) => {
    const item = await accessible(request, true);
    const input = z.strictObject({ question: libraryContent,
      sourceVersionId: z.string().optional() }).parse(request.body);
    const sourceId = input.sourceVersionId ? id(input.sourceVersionId) : item.currentVersionId;
    if (!await revisions.findOne({ _id: sourceId, questionId: item._id })) fail('NOT_FOUND', 404, 'Source version not found');
    ok(response, await createVersion(item, input.question, sourceId, request.userId), 201);
  });
  app.put('/api/library-questions/:questionId/versions/:versionId', requireLogin, async (request, response) => {
    const item = await accessible(request, true);
    const version = await revisions.findOne({ _id: id(request.params.versionId), questionId: item._id });
    if (!version) fail('NOT_FOUND', 404, 'Question version not found');
    const { question: content } = z.strictObject({ question: libraryContent }).parse(request.body);
    if (sameContent(content, version.content)) return ok(response, { ...version, updatedSurveys: 0 });
    const revision = (version.contentRevision || 1) + 1;
    const now = new Date();
    const records = await surveys.find({ ownerId: request.userId,
      status: { $in: ['draft', 'published'] } }).toArray();
    const changes = [];
    for (const record of records) {
      const draft = replaceLinked(record.draftQuestions, item, version, content, revision);
      let published = null;
      let previous = null;
      if (record.status === 'published' && (!record.deadline || record.deadline > now)) {
        previous = await versions.findOne({ _id: record.publishedVersionId, surveyId: record._id });
        if (previous) {
          published = replaceLinked(previous.questions, item, version, content, revision, previous._id);
          if (published.changed) validateSurveyLogic(published.questions);
        }
      }
      if (draft.changed || published?.changed) changes.push({ record, draft, published, previous });
    }
    const changed = await revisions.updateOne({ _id: version._id, questionId: item._id,
      content: version.content }, {
      $set: { content, contentRevision: revision },
      $push: { contentHistory: { revision: revision - 1,
        content: version.content, overwrittenAt: now, overwrittenBy: request.userId } }
    });
    if (!changed.modifiedCount) fail('CONFLICT', 409, 'Question version changed');
    for (const { record, draft, published, previous } of changes) {
      let inserted = null;
      const fields = { updatedAt: now };
      if (draft.changed) fields.draftQuestions = draft.questions;
      try {
        if (published?.changed) {
          const latest = await versions.findOne({ surveyId: record._id }, { sort: { version: -1 } });
          inserted = await versions.insertOne({ surveyId: record._id,
            version: (latest?.version || previous.version) + 1, questions: published.questions,
            publishedAt: now, publishedBy: request.userId });
          fields.publishedVersionId = inserted.insertedId;
          if (record.draftBaseVersionId?.equals(record.publishedVersionId)) {
            fields.draftBaseVersionId = inserted.insertedId;
          }
        }
        const result = await surveys.updateOne({ _id: record._id, ownerId: request.userId,
          status: record.status, updatedAt: record.updatedAt,
          publishedVersionId: record.publishedVersionId }, { $set: fields });
        if (!result.modifiedCount) fail('CONFLICT', 409, 'Survey changed during question overwrite');
      } catch (error) {
        if (inserted) await versions.deleteOne({ _id: inserted.insertedId });
        throw error;
      }
    }
    ok(response, { ...version, content, contentRevision: revision,
      updatedSurveys: changes.length });
  });
  app.post('/api/library-questions/:questionId/versions/:versionId/restore', requireLogin, async (request, response) => {
    const item = await accessible(request, true);
    const source = await revisions.findOne({ _id: id(request.params.versionId), questionId: item._id });
    if (!source) fail('NOT_FOUND', 404, 'Question version not found');
    const result = await library.updateOne({ _id: item._id, ownerId: request.userId,
      currentVersionId: item.currentVersionId },
    { $set: { currentVersionId: source._id, updatedAt: new Date() } });
    if (!result.matchedCount) fail('CONFLICT', 409, 'Question changed while selecting default version');
    ok(response, { versionId: source._id.toString(), version: source.version });
  });
  app.post('/api/library-questions/:questionId/share-link', requireLogin, async (request, response) => {
    const item = await accessible(request, true);
    const token = randomBytes(32).toString('base64url');
    await library.updateOne({ _id: item._id, ownerId: request.userId, ...available },
      { $set: { shareTokenHash: tokenHash(token), updatedAt: new Date() } });
    ok(response, { token });
  });
  app.delete('/api/library-questions/:questionId/share-link', requireLogin, async (request, response) => {
    const item = await accessible(request, true);
    await library.updateOne({ _id: item._id, ownerId: request.userId },
      { $unset: { shareTokenHash: '' }, $set: { updatedAt: new Date() } });
    ok(response, {});
  });
  app.post('/api/library-questions/import', requireLogin, async (request, response) => {
    const { token } = z.strictObject({ token: z.string().min(32).max(256) }).parse(request.body);
    const source = await library.findOne({ shareTokenHash: tokenHash(token), ...available });
    if (!source) fail('NOT_FOUND', 404, 'Share link is invalid or closed');
    if (source.ownerId.equals(request.userId)) fail('VALIDATION_ERROR', 400, 'This is your own question');
    const sourceVersion = await revisions.findOne({ _id: source.currentVersionId, questionId: source._id });
    if (!sourceVersion) fail('CONFLICT', 409, 'Shared question version is missing');
    const now = new Date();
    const itemId = new ObjectId();
    const versionId = new ObjectId();
    const item = { _id: itemId, bankId: null, ownerId: request.userId, sharedWith: [],
      currentVersionId: versionId, originRefs: [], createdAt: now, updatedAt: now };
    const version = { _id: versionId, questionId: itemId, version: 1,
      content: structuredClone(sourceVersion.content), contentRevision: 1,
      sourceVersionId: null, createdBy: request.userId, createdAt: now };
    await revisions.insertOne(version);
    try { await library.insertOne(item); } catch (error) {
      await revisions.deleteOne({ _id: versionId });
      throw error;
    }
    ok(response, { ...item, currentVersion: version }, 201);
  });
  app.post('/api/surveys/:id/questions/from-library', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    const input = z.strictObject({ questionVersionId: z.string(), qid: z.string().trim().min(1) }).parse(request.body);
    const version = await revisions.findOne({ _id: id(input.questionVersionId) });
    if (!version) fail('NOT_FOUND', 404, 'Question version not found');
    const item = await library.findOne({ _id: version.questionId });
    if (!item || !item.ownerId.equals(request.userId) || item.archivedAt) {
      fail('NOT_OWNER', 403, 'Library question is private');
    }
    const question = { qid: input.qid, ...structuredClone(version.content),
      jumpRules: [], libraryQuestionId: item._id.toString(), questionVersionId: version._id.toString(),
      contentRevision: version.contentRevision || 1 };
    const result = await surveys.updateOne({ ...editableFilter(record),
      updatedAt: record.updatedAt, 'draftQuestions.qid': { $ne: input.qid } },
    { $push: { draftQuestions: question }, $set: { updatedAt: new Date() } });
    if (!result.modifiedCount) fail('CONFLICT', 409, 'Question id exists or survey changed');
    ok(response, question, 201);
  });
  app.post('/api/surveys/:id/questions/from-library/batch', requireLogin, async (request, response) => {
    const record = await editableSurvey(request);
    const { questionVersionIds } = z.strictObject({
      questionVersionIds: z.array(z.string()).min(1).max(100)
    }).parse(request.body);
    if (new Set(questionVersionIds).size !== questionVersionIds.length) {
      fail('VALIDATION_ERROR', 400, 'Duplicate question version');
    }
    const selected = [];
    for (const versionId of questionVersionIds) {
      const version = await revisions.findOne({ _id: id(versionId) });
      const item = version && await library.findOne({ _id: version.questionId,
        ownerId: request.userId, ...available });
      if (!item) fail('NOT_OWNER', 403, 'Question version is not available');
      selected.push({ version, item });
    }
    let next = Math.max(record.draftQuestions.length,
      ...record.draftQuestions.map((question) => /^\d+$/.test(question.qid) ? Number(question.qid) : 0)) + 1;
    const questions = selected.map(({ version, item }) => ({ qid: String(next++),
      ...structuredClone(version.content), jumpRules: [], libraryQuestionId: item._id.toString(),
      questionVersionId: version._id.toString(), contentRevision: version.contentRevision || 1 }));
    const updated = await surveys.updateOne({ ...editableFilter(record),
      updatedAt: record.updatedAt, draftQuestions: record.draftQuestions },
    { $set: { draftQuestions: [...record.draftQuestions, ...questions], updatedAt: new Date() } });
    if (!updated.modifiedCount) fail('CONFLICT', 409, 'Survey changed while adding questions');
    ok(response, questions, 201);
  });
  app.get('/api/library-questions/:questionId/usage', requireLogin, async (request, response) => {
    const item = await accessible(request, true);
    const key = item._id.toString();
    const drafts = await surveys.find({ ownerId: request.userId, 'draftQuestions.libraryQuestionId': key },
      { projection: { title: 1, status: 1, ownerId: 1, draftQuestions: 1 } }).toArray();
    const ownedSurveys = await surveys.find({ ownerId: request.userId }, { projection: { _id: 1 } }).toArray();
    const published = await versions.find({ surveyId: { $in: ownedSurveys.map((survey) => survey._id) },
      $or: [{ 'questions.libraryQuestionId': key },
        { _id: { $in: (item.originRefs || []).map((ref) => ref.surveyVersionId) } }] },
      { projection: { surveyId: 1, version: 1, questions: 1 } }).toArray();
    const ids = [...new Set(published.map((version) => version.surveyId.toString()))].map((value) => new ObjectId(value));
    const surveyNames = await surveys.find({ _id: { $in: ids } }, { projection: { title: 1, ownerId: 1 } }).toArray();
    const byId = new Map(surveyNames.map((survey) => [survey._id.toString(), survey]));
    ok(response, { drafts: drafts.flatMap((survey) => survey.draftQuestions
      .filter((question) => question.libraryQuestionId === key)
      .map((question) => ({ surveyId: survey._id.toString(), title: survey.title, status: survey.status,
        qid: question.qid, questionVersionId: question.questionVersionId }))),
    published: published.flatMap((version) => version.questions
      .map((question) => ({ question, origin: (item.originRefs || []).find((ref) =>
        ref.surveyVersionId.equals(version._id) && ref.qid === question.qid) }))
      .filter(({ question, origin }) => question.libraryQuestionId === key || origin)
      .map(({ question, origin }) => ({ surveyId: version.surveyId.toString(), title: byId.get(version.surveyId.toString())?.title,
        surveyVersionId: version._id.toString(), surveyVersion: version.version,
        qid: question.qid, questionVersionId: question.questionVersionId || origin.questionVersionId.toString() }))) });
  });
  app.get('/api/library-questions/:questionId/statistics', requireLogin, async (request, response) => {
    const item = await accessible(request, true);
    const revisionId = request.query.versionId === undefined ? null : id(request.query.versionId);
    if (revisionId && !await revisions.findOne({ _id: revisionId, questionId: item._id })) {
      fail('NOT_FOUND', 404, 'Question version not found');
    }
    const ownedSurveys = await surveys.find({ ownerId: request.userId }, { projection: { _id: 1 } }).toArray();
    const history = await revisions.find({ questionId: item._id,
      ...(revisionId && { _id: revisionId }) }).sort({ version: 1 }).toArray();
    ok(response, await getLibraryStatistics(responses, versions, item._id, history,
      ownedSurveys.map((survey) => survey._id), item.originRefs || []));
  });
}

module.exports = { mountLibraryRoutes };
