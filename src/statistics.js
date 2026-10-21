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
      optionId: option.id, count: counts.get(option.id) || 0
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

module.exports = { getStatistics };
