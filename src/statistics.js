'use strict';

const answerStages = (type, qid) => [
  { $unwind: '$answers' },
  { $match: { 'answers.type': type, 'answers.qid': qid } }
];

function questionFacet(question) {
  const stages = answerStages(question.type, question.qid);
  switch (question.type) {
    case 'single':
      return [...stages, { $group: { _id: '$answers.value', count: { $sum: 1 } } }];
    case 'multi':
      return [...stages, { $unwind: '$answers.value' },
        { $group: { _id: '$answers.value', count: { $sum: 1 } } }];
    case 'text':
      return [...stages,
        { $match: { $expr: { $ne: [{ $trim: { input: '$answers.value' } }, ''] } } },
        { $sort: { submittedAt: 1, _id: 1 } },
        { $group: { _id: null, values: { $push: '$answers.value' } } }];
    case 'number':
    case 'rating':
      return [...stages,
        { $match: { 'answers.value': { $type: 'number' } } },
        { $sort: { submittedAt: 1, _id: 1 } },
        { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$answers.value' },
          min: { $min: '$answers.value' }, max: { $max: '$answers.value' },
          values: { $push: '$answers.value' } } }];
    default:
      throw new Error(`Unsupported question type: ${question.type}`);
  }
}

function formatQuestion(question, rows) {
  const basic = { qid: question.qid, type: question.type, title: question.title };
  if (question.type === 'single' || question.type === 'multi') {
    const counts = new Map(rows.map((row) => [row._id, row.count]));
    return { ...basic, ...(question.type === 'single' ? { count: rows.reduce((sum, row) => sum + row.count, 0) } : {}),
      counts: (question.options || []).map((option) => ({
      optionId: option.id, text: option.text, count: counts.get(option.id) || 0
      })) };
  }
  if (question.type === 'text') return { ...basic, count: rows[0]?.values.length || 0,
    values: rows[0]?.values || [] };
  const result = rows[0];
  return { ...basic, count: result?.count || 0, avg: result?.avg ?? null,
    min: result?.min ?? null, max: result?.max ?? null, values: result?.values || [] };
}

async function getStatistics(responses, surveyId, version, qid = null) {
  const questions = qid ? version.questions.filter((question) => question.qid === qid) : version.questions;
  const facet = { total: [{ $count: 'count' }] };
  questions.forEach((question, index) => { facet[`question${index}`] = questionFacet(question); });
  const [result] = await responses.aggregate([
    { $match: { surveyId, versionId: version._id } },
    { $project: { answers: 1, submittedAt: 1 } },
    { $facet: facet }
  ]).toArray();
  const base = {
    surveyId: surveyId.toString(),
    versionId: version._id.toString(),
    totalResponses: result.total[0]?.count || 0
  };
  const formatted = questions.map((question, index) => formatQuestion(question, result[`question${index}`]));
  return qid ? { ...base, question: formatted[0] } : { ...base, questions: formatted };
}

async function getLibraryStatistics(responses, surveyVersions, questionId, history, surveyIds, originRefs = []) {
  const ids = history.map((version) => version._id.toString());
  const refs = originRefs.filter((ref) => ids.includes(ref.questionVersionId.toString()));
  const refBranches = refs.map((ref) => ({
    case: { $and: [{ $eq: ['$versionId', ref.surveyVersionId] },
      { $eq: ['$snapshot.questions.qid', ref.qid] }] },
    then: ref.questionVersionId.toString()
  }));
  const sourceMatch = { $or: [
    { 'snapshot.questions.libraryQuestionId': questionId.toString(),
      'snapshot.questions.questionVersionId': { $in: ids } },
    ...refs.map((ref) => ({ versionId: ref.surveyVersionId,
      'snapshot.questions.qid': ref.qid }))
  ] };
  const sourceId = { $ifNull: ['$snapshot.questions.questionVersionId',
    refBranches.length ? { $switch: { branches: refBranches, default: null } } : null] };
  let surveyVersionCounts = [];
  let result = { answered: [], choices: [], texts: [], numbers: [] };
  if (ids.length && surveyIds.length) {
    surveyVersionCounts = await surveyVersions.aggregate([
      { $match: { surveyId: { $in: surveyIds } } },
      { $unwind: '$questions' },
      { $set: { versionId: '$_id', 'snapshot.questions': '$questions' } },
      { $match: sourceMatch },
      { $project: { snapshotId: '$_id', key: {
        versionId: sourceId, revision: { $ifNull: ['$questions.contentRevision', 1] }
      } } },
      { $match: { 'key.versionId': { $in: ids } } },
      { $group: { _id: { key: '$key', snapshotId: '$snapshotId' } } },
      { $group: { _id: '$_id.key', count: { $sum: 1 } } }
    ]).toArray();
    [result] = await responses.aggregate([
      { $match: { surveyId: { $in: surveyIds } } },
      { $lookup: { from: surveyVersions.collectionName, localField: 'versionId',
        foreignField: '_id', as: 'snapshot' } },
      { $unwind: '$snapshot' },
      { $unwind: '$snapshot.questions' },
      { $match: sourceMatch },
      { $set: { question: '$snapshot.questions',
        statVersionId: sourceId,
        statRevision: { $ifNull: ['$snapshot.questions.contentRevision', 1] },
        answer: { $first: { $filter: { input: '$answers', as: 'answer',
          cond: { $eq: ['$$answer.qid', '$snapshot.questions.qid'] } } } } } },
      { $match: { 'answer.qid': { $exists: true }, statVersionId: { $in: ids } } },
      { $set: { hasValue: { $switch: { branches: [
        { case: { $eq: ['$question.type', 'text'] },
          then: { $ne: [{ $trim: { input: '$answer.value' } }, ''] } },
        { case: { $eq: ['$question.type', 'multi'] },
          then: { $gt: [{ $size: '$answer.value' }, 0] } }
      ], default: true } } } },
      { $match: { hasValue: true } },
      { $project: { question: 1, answer: 1, submittedAt: 1,
        key: { versionId: '$statVersionId', revision: '$statRevision' } } },
      { $facet: {
        answered: [{ $group: { _id: '$key', count: { $sum: 1 } } }],
        choices: [{ $match: { 'question.type': { $in: ['single', 'multi'] } } },
          { $project: { key: 1, choices: { $cond: [
            { $isArray: '$answer.value' }, '$answer.value', ['$answer.value'] ] } } },
          { $unwind: '$choices' },
          { $group: { _id: { key: '$key', optionId: '$choices' }, count: { $sum: 1 } } }],
        texts: [{ $match: { 'question.type': 'text', 'answer.value': { $type: 'string' } } },
          { $sort: { submittedAt: 1, _id: 1 } },
          { $group: { _id: '$key', values: { $push: '$answer.value' } } }],
        numbers: [{ $match: { 'question.type': { $in: ['number', 'rating'] },
          'answer.value': { $type: 'number' } } },
          { $group: { _id: '$key', avg: { $avg: '$answer.value' },
            min: { $min: '$answer.value' }, max: { $max: '$answer.value' },
            values: { $push: '$answer.value' } } }]
      } }
    ]).toArray();
  }
  const sameKey = (key, versionId, revision) => key.versionId === versionId &&
    key.revision === revision;
  return { questionId: questionId.toString(), versions: history.map((version) => {
    const versionId = version._id.toString();
    const revisions = [...(version.contentHistory || []),
      { revision: version.contentRevision || 1, content: version.content }].map((entry) => {
      const revision = entry.revision;
      const numeric = result.numbers.find((row) => sameKey(row._id, versionId, revision));
      const values = result.texts.find((row) => sameKey(row._id, versionId, revision))?.values || [];
      return { contentRevision: revision, type: entry.content.type, title: entry.content.title,
        surveyVersionCount: surveyVersionCounts.find((row) => sameKey(row._id,
          versionId, revision))?.count || 0,
        answerCount: result.answered.find((row) => sameKey(row._id, versionId, revision))?.count || 0,
        counts: (entry.content.options || []).map((option) => ({ optionId: option.id,
          text: option.text, count: result.choices.find((row) => sameKey(row._id.key,
            versionId, revision) && row._id.optionId === option.id)?.count || 0 })),
        values: entry.content.type === 'text' ? values : numeric?.values || [],
        avg: numeric?.avg ?? null, min: numeric?.min ?? null, max: numeric?.max ?? null };
    });
    return { versionId, version: version.version, ...revisions.at(-1),
      ...(revisions.length > 1 && { revisions }) };
  }) };
}

module.exports = { getStatistics, getLibraryStatistics };
