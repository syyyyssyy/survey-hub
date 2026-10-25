'use strict';

const { z } = require('zod');

const nonempty = z.string().trim().min(1);
const option = z.strictObject({ id: nonempty, text: nonempty });
const optionIds = z.array(nonempty).min(1).refine((ids) => new Set(ids).size === ids.length, 'Duplicate condition option');
const validation = z.strictObject({
  minSelect: z.number().int().min(0).optional(),
  maxSelect: z.number().int().min(0).optional(),
  exactSelect: z.number().int().min(0).nullable().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  integer: z.boolean().optional()
});
const jumpRule = z.strictObject({
  id: nonempty,
  when: z.union([
    z.strictObject({ optionId: nonempty }),
    z.strictObject({ containsOptionId: nonempty }),
    z.strictObject({ containsAnyOptionIds: optionIds }),
    z.strictObject({ containsAllOptionIds: optionIds }),
    z.strictObject({ exactOptionIds: optionIds }),
    z.strictObject({ excludesOptionIds: optionIds }),
    z.strictObject({ op: z.enum(['gte', 'gt', 'lte', 'lt', 'eq']), value: z.number().finite() }),
    z.strictObject({ op: z.literal('between'), min: z.number().finite(), max: z.number().finite() })
  ]),
  targetQid: nonempty
});
const question = z.strictObject({
  qid: nonempty,
  libraryQuestionId: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  questionVersionId: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  contentRevision: z.number().int().positive().optional(),
  type: z.enum(['single', 'multi', 'text', 'number', 'rating']),
  title: nonempty,
  required: z.boolean(),
  options: z.array(option).optional(),
  validation: validation.optional(),
  jumpRules: z.array(jumpRule).optional()
}).superRefine((value, context) => {
  if (!!value.libraryQuestionId !== !!value.questionVersionId) {
    context.addIssue({ code: 'custom', message: 'Library question and version ids must occur together' });
  }
  const ids = (value.options || []).map((item) => item.id);
  if (ids.length !== new Set(ids).size) context.addIssue({ code: 'custom', message: 'Duplicate option id' });
  const ruleIds = (value.jumpRules || []).map((item) => item.id);
  if (ruleIds.length !== new Set(ruleIds).size) context.addIssue({ code: 'custom', message: 'Duplicate rule id' });
  if (['single', 'multi'].includes(value.type) && !ids.length) {
    context.addIssue({ code: 'custom', message: 'Choice questions need options' });
  }
  if (!['single', 'multi'].includes(value.type) && value.options?.length) {
    context.addIssue({ code: 'custom', message: 'Options require a choice question' });
  }
  for (const rule of value.jumpRules || []) {
    const kind = Object.hasOwn(rule.when, 'optionId') ? 'single' :
      ['containsOptionId', 'containsAnyOptionIds', 'containsAllOptionIds', 'exactOptionIds', 'excludesOptionIds']
        .some((key) => Object.hasOwn(rule.when, key)) ? 'multi' : 'number';
    const selectedIds = rule.when.optionId ? [rule.when.optionId] : rule.when.containsOptionId
      ? [rule.when.containsOptionId] : rule.when.containsAnyOptionIds ||
        rule.when.containsAllOptionIds || rule.when.exactOptionIds || rule.when.excludesOptionIds || [];
    if (kind !== (value.type === 'rating' ? 'number' : value.type) || selectedIds.some((id) => !ids.includes(id)) ||
        (rule.when.op === 'between' && rule.when.min > rule.when.max)) {
      context.addIssue({ code: 'custom', message: 'Jump condition does not match question' });
    }
  }
  const limits = value.validation || {};
  if ((limits.minSelect != null && limits.maxSelect != null && limits.minSelect > limits.maxSelect) ||
      (limits.minLength != null && limits.maxLength != null && limits.minLength > limits.maxLength) ||
      (limits.min != null && limits.max != null && limits.min > limits.max)) {
    context.addIssue({ code: 'custom', message: 'Invalid validation range' });
  }
  if (value.type === 'multi' && limits.exactSelect != null &&
      ((limits.minSelect != null && limits.exactSelect < limits.minSelect) ||
       (limits.maxSelect != null && limits.exactSelect > limits.maxSelect) ||
       limits.exactSelect > ids.length)) {
    context.addIssue({ code: 'custom', message: 'Exact selection conflicts with option limits' });
  }
  if (value.type === 'rating' && (limits.min == null || limits.max == null ||
      !Number.isInteger(limits.min) || !Number.isInteger(limits.max) ||
      limits.min < 1 || limits.max > 10 || limits.min >= limits.max || limits.integer !== true)) {
    context.addIssue({ code: 'custom', message: 'Rating requires integer bounds from 1 to 10' });
  }
});

const credentials = z.strictObject({ username: nonempty.max(80), password: z.string().min(8).max(128) });
const survey = z.strictObject({
  title: nonempty.max(200),
  description: z.string().max(2000).default(''),
  allowAnonymous: z.boolean().default(true),
  allowMultiple: z.boolean().default(false),
  deadline: z.iso.datetime({ offset: true }).nullable().default(null)
});

const answer = z.discriminatedUnion('type', [
  z.strictObject({ qid: nonempty, type: z.literal('single'), value: z.string() }),
  z.strictObject({ qid: nonempty, type: z.literal('multi'), value: z.array(z.string()) }),
  z.strictObject({ qid: nonempty, type: z.literal('text'), value: z.string() }),
  z.strictObject({ qid: nonempty, type: z.literal('number'), value: z.number().finite() }),
  z.strictObject({ qid: nonempty, type: z.literal('rating'), value: z.number().int() })
]);
const submission = z.strictObject({
  versionId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  clientSubmissionId: nonempty.max(128),
  anonymous: z.boolean(),
  answers: z.array(answer)
});
const nextStep = z.strictObject({
  versionId: submission.shape.versionId,
  currentQid: nonempty,
  answers: submission.shape.answers
});

const libraryContent = z.strictObject({
  type: z.enum(['single', 'multi', 'text', 'number', 'rating']),
  title: nonempty,
  required: z.boolean(),
  options: z.array(option).optional(),
  validation: validation.optional()
}).superRefine((value, context) => {
  if (!question.safeParse({ qid: 'library', ...value, jumpRules: [] }).success) {
    context.addIssue({ code: 'custom', message: 'Invalid library question content' });
  }
});

module.exports = { credentials, survey, question, libraryContent, submission, nextStep };
