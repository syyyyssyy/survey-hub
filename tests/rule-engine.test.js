const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAnswer, resolveNextQuestion, replayPath } = require('../src/rule-engine');

const question = (qid, type, extra = {}) => ({ qid, type, title: qid, required: true, ...extra });
const answer = (qid, type, value) => ({ qid, type, value });
const rejects = (code) => (error) => error.code === code;

test('single choice accepts declared options and rejects unknown or mismatched answers', () => {
  const q = question('start', 'single', { options: [{ id: 'yes' }, { id: 'no' }] });
  assert.equal(validateAnswer(q, answer('start', 'single', 'yes')), true);
  assert.throws(() => validateAnswer(q, answer('start', 'single', 'other')), rejects('VALIDATION_ERROR'));
  assert.throws(() => validateAnswer(q, answer('wrong', 'single', 'yes')), rejects('VALIDATION_ERROR'));
  assert.throws(() => validateAnswer(q, answer('start', 'multi', ['yes'])), rejects('VALIDATION_ERROR'));
});

test('multi choice validates membership, uniqueness and selection limits', () => {
  const q = question('choices', 'multi', {
    options: ['A', 'B', 'C'].map((id) => ({ id })),
    validation: { minSelect: 2, maxSelect: 2 }
  });
  assert.equal(validateAnswer(q, answer('choices', 'multi', ['A', 'B'])), true);
  for (const value of [['A'], ['A', 'B', 'C'], ['A', 'A'], ['A', 'X']]) {
    assert.throws(() => validateAnswer(q, answer('choices', 'multi', value)), rejects('VALIDATION_ERROR'));
  }
  assert.equal(validateAnswer({ ...q, validation: { exactSelect: 1 } }, answer('choices', 'multi', ['C'])), true);
  assert.throws(() => validateAnswer({ ...q, validation: { exactSelect: 1 } }, answer('choices', 'multi', ['A', 'B'])), rejects('VALIDATION_ERROR'));
});

test('text length and number bounds/integer are checked', () => {
  const textQuestion = question('memo', 'text', { validation: { minLength: 2, maxLength: 4 } });
  assert.equal(validateAnswer(textQuestion, answer('memo', 'text', 'okay')), true);
  for (const value of ['x', 'longer']) {
    assert.throws(() => validateAnswer(textQuestion, answer('memo', 'text', value)), rejects('VALIDATION_ERROR'));
  }
  const numberQuestion = question('age', 'number', { validation: { min: 18, max: 65, integer: true } });
  assert.equal(validateAnswer(numberQuestion, answer('age', 'number', 18)), true);
  for (const value of [17, 66, 18.5, NaN, '20']) {
    assert.throws(() => validateAnswer(numberQuestion, answer('age', 'number', value)), rejects('VALIDATION_ERROR'));
  }
});

test('required answers are enforced; an optional unanswered question is valid', () => {
  assert.throws(() => validateAnswer(question('required', 'text'), undefined), rejects('VALIDATION_ERROR'));
  assert.throws(() => validateAnswer(question('required', 'text'), answer('required', 'text', '  ')), rejects('VALIDATION_ERROR'));
  assert.equal(validateAnswer(question('optional', 'text', { required: false }), undefined), true);
  assert.throws(() => validateAnswer(question('optional', 'text', { required: false }), answer('optional', 'text', null)), rejects('VALIDATION_ERROR'));
});

test('first matching single-choice rule wins and unmatched answers use array order', () => {
  const questions = [
    question('entry', 'single', {
      jumpRules: [
        { id: 'r1', when: { optionId: 'A' }, targetQid: 'finish' },
        { id: 'r2', when: { optionId: 'A' }, targetQid: 'middle' }
      ]
    }),
    question('middle', 'text'),
    question('finish', 'text')
  ];
  assert.equal(resolveNextQuestion(questions, 'entry', answer('entry', 'single', 'A')), 'finish');
  assert.equal(resolveNextQuestion(questions, 'entry', answer('entry', 'single', 'B')), 'middle');
  assert.equal(resolveNextQuestion(questions, 'finish', answer('finish', 'text', 'done')), null);
});

test('multi-choice containsOptionId and numeric comparisons resolve declared targets', () => {
  const questions = [
    question('pick', 'multi', { jumpRules: [{ id: 'r', when: { containsOptionId: 'B' }, targetQid: 'age' }] }),
    question('fallback', 'text'),
    question('age', 'number', { jumpRules: [
      { id: 'adult', when: { op: 'gte', value: 18 }, targetQid: 'end' },
      { id: 'child', when: { op: 'lt', value: 18 }, targetQid: 'fallback' }
    ] }),
    question('end', 'text')
  ];
  assert.equal(resolveNextQuestion(questions, 'pick', answer('pick', 'multi', ['A', 'B'])), 'age');
  assert.equal(resolveNextQuestion(questions, 'age', answer('age', 'number', 18)), 'end');
  assert.equal(resolveNextQuestion(questions, 'age', answer('age', 'number', 17)), 'fallback');
  assert.equal(resolveNextQuestion(questions, 'age', answer('age', 'number', 17.5)), 'fallback');
});

test('all numeric rule operators are interpreted from the rule data', () => {
  for (const [op, input, expected] of [
    ['gt', 19, 'target'], ['gt', 18, 'next'],
    ['lte', 18, 'target'], ['lte', 19, 'next'],
    ['eq', 18, 'target'], ['eq', 19, 'next']
  ]) {
    const questions = [
      question('numeric', 'number', { jumpRules: [{ id: 'compare', when: { op, value: 18 }, targetQid: 'target' }] }),
      question('next', 'text'),
      question('target', 'text')
    ];
    assert.equal(resolveNextQuestion(questions, 'numeric', answer('numeric', 'number', input)), expected);
  }
});

test('multi-choice combinations and inclusive numeric intervals use declared rules', () => {
  const targets = ['next', 'any', 'all', 'exact'].map((qid) => question(qid, 'text'));
  const multi = question('pick', 'multi', { options: ['A', 'B', 'C'].map((id) => ({ id })), jumpRules: [
    { id: 'exact', when: { exactOptionIds: ['A', 'B'] }, targetQid: 'exact' },
    { id: 'all', when: { containsAllOptionIds: ['A', 'B'] }, targetQid: 'all' },
    { id: 'any', when: { containsAnyOptionIds: ['B', 'C'] }, targetQid: 'any' }
  ] });
  const questions = [multi, ...targets];
  assert.equal(resolveNextQuestion(questions, 'pick', answer('pick', 'multi', ['A', 'B'])), 'exact');
  assert.equal(resolveNextQuestion(questions, 'pick', answer('pick', 'multi', ['A', 'B', 'C'])), 'all');
  assert.equal(resolveNextQuestion(questions, 'pick', answer('pick', 'multi', ['C'])), 'any');
  assert.equal(resolveNextQuestion(questions, 'pick', answer('pick', 'multi', ['A'])), 'next');

  const numeric = [question('age', 'number', { jumpRules: [
    { id: 'range', when: { op: 'between', min: 18, max: 60 }, targetQid: 'inside' }
  ] }), question('outside', 'text'), question('inside', 'text')];
  for (const value of [18, 30, 60]) assert.equal(resolveNextQuestion(numeric, 'age', answer('age', 'number', value)), 'inside');
  for (const value of [17, 61]) assert.equal(resolveNextQuestion(numeric, 'age', answer('age', 'number', value)), 'outside');
});

test('replay follows jumps without validating skipped required questions', () => {
  const questions = [
    question('entry', 'single', { options: [{ id: 'go' }], jumpRules: [{ id: 'skip', when: { optionId: 'go' }, targetQid: 'end' }] }),
    question('skipped', 'text'),
    question('end', 'number')
  ];
  const answers = [answer('entry', 'single', 'go'), answer('end', 'number', 0)];
  assert.deepEqual(replayPath(questions, answers), ['entry', 'end']);
  assert.deepEqual(answers, [answer('entry', 'single', 'go'), answer('end', 'number', 0)]);
  assert.throws(() => replayPath(questions, [...answers, answer('skipped', 'text', 'extra')]), rejects('JUMP_PATH_MISMATCH'));
  assert.throws(() => replayPath(questions, [answer('entry', 'single', 'go')]), rejects('VALIDATION_ERROR'));
});

test('replay rejects unknown and duplicate answers, including an empty survey', () => {
  const questions = [question('only', 'text')];
  assert.throws(() => replayPath(questions, [answer('only', 'text', 'ok'), answer('only', 'text', 'again')]), rejects('VALIDATION_ERROR'));
  assert.throws(() => replayPath(questions, [answer('only', 'text', 'ok'), answer('outside', 'text', 'x')]), rejects('JUMP_PATH_MISMATCH'));
  assert.deepEqual(replayPath([], []), []);
  assert.throws(() => replayPath([], [answer('outside', 'text', 'x')]), rejects('JUMP_PATH_MISMATCH'));
});

test('replay combines multi-choice and numeric jumps from question data', () => {
  const questions = [
    question('select', 'multi', {
      options: [{ id: 'ordinary' }, { id: 'special' }],
      jumpRules: [{ id: 'toAge', when: { containsOptionId: 'special' }, targetQid: 'years' }]
    }),
    question('skippedOne', 'text'),
    question('years', 'number', {
      jumpRules: [{ id: 'adult', when: { op: 'gte', value: 18 }, targetQid: 'last' }]
    }),
    question('skippedTwo', 'text'),
    question('last', 'single', { options: [{ id: 'done' }] })
  ];
  assert.deepEqual(replayPath(questions, [
    answer('select', 'multi', ['special']),
    answer('years', 'number', 18),
    answer('last', 'single', 'done')
  ]), ['select', 'years', 'last']);
});

test('replay reports an invalid cycle instead of looping', () => {
  const questions = [question('loop', 'single', {
    options: [{ id: 'again' }],
    jumpRules: [{ id: 'cycle', when: { optionId: 'again' }, targetQid: 'loop' }]
  })];
  assert.throws(() => replayPath(questions, [answer('loop', 'single', 'again')]), rejects('INVALID_SURVEY_LOGIC'));
});

test('multi exclusion rules match only when every specified option is absent', () => {
  const questions = [
    question('pick', 'multi', { required: false, options: ['A', 'B', 'C'].map((id) => ({ id })),
      jumpRules: [
        { id: 'noneAB', when: { excludesOptionIds: ['A', 'B'] }, targetQid: 'skipped' },
        { id: 'noA', when: { excludesOptionIds: ['A'] }, targetQid: 'last' }
      ] }),
    question('ordinary', 'text', { required: false }),
    question('skipped', 'text', { required: false }),
    question('last', 'text', { required: false })
  ];
  const resolve = (value) => resolveNextQuestion(questions, 'pick', value === undefined ? undefined : answer('pick', 'multi', value));
  assert.equal(resolve(['C']), 'skipped');
  assert.equal(resolve([]), 'skipped');
  assert.equal(resolve(undefined), 'skipped');
  assert.equal(resolve(['B']), 'last');
  assert.equal(resolve(['A']), 'ordinary');
  assert.deepEqual(replayPath(questions, []), ['pick', 'skipped', 'last']);
});
