'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { user: null, surveys: [], survey: null, publicSurvey: null, currentQid: null, history: [], answers: new Map(), submissionId: null, authMode: 'login', dialogAction: null, banks: [], library: [], libraryMode: 'manage', libraryManaging: false };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined });
  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    throw new Error(`当前服务未加载此接口（${url}，HTTP ${response.status}）。请从最新启动的网页地址打开项目并重新生成分享链接。`);
  }
  const result = await response.json();
  if (result.code !== 0) {
    const detail = result.data?.issues?.map((issue) => issue.message).join('；');
    const error = new Error(detail || result.message || result.code);
    error.code = result.code;
    throw error;
  }
  return result.data;
}
const send = (url, method, value) => api(url, { method, body: JSON.stringify(value || {}) });
function notice(message, success = false) {
  const el = $('#message');
  el.textContent = message;
  el.classList.toggle('success', success);
  el.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function clearNotice() { $('#message').hidden = true; }
function show(view) {
  clearNotice();
  document.querySelectorAll('.view').forEach((element) => { element.hidden = element.id !== `${view}-view`; });
  $('#nav').hidden = !state.user;
  $('#user').textContent = state.user?.username || '';
  location.hash = view;
}
async function run(action) {
  try { await action(); } catch (error) { notice(error.message); }
}
function formatDate(value) { return value ? new Date(value).toLocaleString('zh-CN') : '无截止时间'; }

async function refreshSurveys() {
  state.surveys = await api('/api/surveys/mine');
  $('#survey-list').innerHTML = state.surveys.length ? state.surveys.map((survey) => `
    <div class="row"><div class="row-main"><div class="row-title">${escapeHtml(survey.title)}</div>
    <div class="row-sub">${{ draft: '草稿', published: '已发布', closed: '已关闭' }[survey.status]} · ${survey.draftQuestions.length} 题 · ${escapeHtml(formatDate(survey.deadline))}</div></div>
    <div class="row-actions"><button type="button" class="secondary" data-open="${survey._id}">打开</button>
    ${survey.status === 'published' ? `<button type="button" class="secondary" data-fill="${escapeHtml(survey.publicId)}">填写</button>` : ''}${survey.publishedVersionId ? `<button type="button" class="secondary" data-stats="${survey._id}">统计</button>` : ''}</div></div>`).join('') : '<p>暂无问卷</p>';
}
async function openSurvey(id) {
  state.survey = await api(`/api/surveys/${id}`);
  const survey = state.survey;
  $('#editor-title').textContent = survey.title;
  const editable = survey.status === 'draft' || !!survey.draftBaseVersionId;
  $('#editor-status').textContent = survey.status === 'draft' ? '草稿' : survey.status === 'closed' ? '已关闭' : editable ? '编辑草稿中' : '已发布';
  $('#editor-meta').innerHTML = `<div>${escapeHtml(survey.description || '无描述')}</div><div>公开 ID：${escapeHtml(survey.publicId)} · ${escapeHtml(formatDate(survey.deadline))}</div>`;
  $('#edit-published').hidden = survey.status !== 'published' || editable;
  $('#add-question').hidden = !editable;
  $('#choose-library').hidden = !editable;
  $('#publish').hidden = !editable;
  $('#copy-link').hidden = survey.status !== 'published';
  $('#open-fill').hidden = survey.status !== 'published';
  $('#open-stats').hidden = !survey.publishedVersionId;
  $('#close-survey').hidden = survey.status !== 'published';
  $('#question-list').innerHTML = survey.draftQuestions.length ? survey.draftQuestions.map((question, index) => `
    <div class="row"><div class="row-main"><div class="row-title">${index + 1}. ${escapeHtml(question.title)}</div>
    <div class="row-sub">${escapeHtml(question.qid)} · ${escapeHtml({ single: '单选', multi: '多选', text: '文本', number: '数字', rating: '评分' }[question.type])} · ${question.required ? '必答' : '选答'}${question.jumpRules?.length ? ` · ${question.jumpRules.length} 条跳转` : ''}</div>
    ${question.options?.length ? `<div class="question-options">${question.options.map((option) => `<span>${escapeHtml(option.id)}. ${escapeHtml(option.text)}</span>`).join('')}</div>` : ''}</div>
    ${editable ? `<div class="row-actions"><button type="button" class="secondary" data-move="up" data-qid="${escapeHtml(question.qid)}" title="上移" aria-label="上移第 ${index + 1} 题" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="secondary" data-move="down" data-qid="${escapeHtml(question.qid)}" title="下移" aria-label="下移第 ${index + 1} 题" ${index === survey.draftQuestions.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="secondary" data-edit="${escapeHtml(question.qid)}">编辑</button><button type="button" class="secondary" data-save-library="${escapeHtml(question.qid)}">存入题库</button><button type="button" class="secondary" data-delete="${escapeHtml(question.qid)}">删除</button></div>` : ''}</div>`).join('') : '<p>暂无题目</p>';
  show('editor');
}

function openDialog(title, fields, action) {
  $('#dialog-title').textContent = title;
  $('#dialog-fields').innerHTML = fields;
  $('#dialog-form button[type="submit"]').textContent = '保存';
  state.dialogAction = action;
  $('#dialog').showModal();
}
function surveyDialog() {
  openDialog('新建问卷', `<label>标题<input name="title" required maxlength="200"></label>
    <label>描述<textarea name="description" maxlength="2000"></textarea></label>
    <div class="grid-two"><label class="check"><input name="allowAnonymous" type="checkbox" checked>允许匿名</label>
    <label class="check"><input name="allowMultiple" type="checkbox">允许重复提交</label></div>
    <label>截止时间<input name="deadline" type="datetime-local"></label>`, async (form) => {
    const deadline = form.elements.deadline.value;
    const survey = await send('/api/surveys', 'POST', {
      title: form.elements.title.value.trim(), description: form.elements.description.value,
      allowAnonymous: form.elements.allowAnonymous.checked, allowMultiple: form.elements.allowMultiple.checked,
      deadline: deadline ? new Date(deadline).toISOString() : null
    });
    await refreshSurveys();
    await openSurvey(survey._id);
  });
}
function numberedQuestions(questions) {
  const ids = new Map(questions.map((question, index) => [question.qid, String(index + 1)]));
  return questions.map((question, index) => ({
    ...question, qid: String(index + 1),
    jumpRules: (question.jumpRules || []).filter((rule) => ids.has(rule.targetQid))
      .map((rule, ruleIndex) => ({ ...rule, id: `r${ruleIndex + 1}`, targetQid: ids.get(rule.targetQid) }))
  }));
}
async function saveQuestions(questions) {
  await send(`/api/surveys/${state.survey._id}/questions`, 'PUT', numberedQuestions(questions));
  await openSurvey(state.survey._id);
}
const optionLetter = (index) => {
  let result = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result;
  return result;
};
function questionDialog(question = null, onSave = null) {
  const currentQid = question?.qid || String((state.survey?.draftQuestions.length || 0) + 1);
  let type = question?.type || 'single';
  let options = (question?.options || []).map((item) => item.text);
  if (!question) options = ['', ''];
  const optionIndex = (id) => (question?.options || []).findIndex((item) => item.id === id);
  let rules = (question?.jumpRules || []).map((rule) => {
    const when = rule.when;
    const mode = when.containsAnyOptionIds ? 'any' : when.containsAllOptionIds ? 'all' :
      when.exactOptionIds ? 'exact' : when.excludesOptionIds ? 'exclude' : 'single';
    const ids = when.containsAnyOptionIds || when.containsAllOptionIds || when.exactOptionIds || when.excludesOptionIds ||
      [when.optionId ?? when.containsOptionId].filter(Boolean);
    return { mode, choices: ids.map(optionIndex), op: when.op || 'gte',
      value: when.value ?? '', min: when.min ?? '', max: when.max ?? '', target: rule.targetQid };
  });
  const selected = (value) => type === value ? 'selected' : '';
  const limit = (name, label, step = '1') => `<label>${label}<input name="${name}" type="number" step="${step}" ${step === '1' ? 'min="0"' : ''} value="${question?.validation?.[name] ?? ''}"></label>`;
  openDialog(question ? '编辑题目' : '添加题目', `
    <section class="question-section"><div class="grid-two"><div class="qid-display">题号<strong>第 ${escapeHtml(currentQid)} 题</strong></div><label>题型<select name="type"><option value="single" ${selected('single')}>单选</option><option value="multi" ${selected('multi')}>多选</option><option value="text" ${selected('text')}>文本填空</option><option value="number" ${selected('number')}>数字填空</option><option value="rating" ${selected('rating')}>评分</option></select></label></div>
    <label>题目内容<input name="title" value="${escapeHtml(question?.title || '')}" required></label>
    <label class="check"><input name="required" type="checkbox" ${question?.required !== false ? 'checked' : ''}>是否必答</label></section>
    <section class="question-section" id="question-config"><h3>题型配置</h3><div id="options-config"><div id="option-rows" class="editor-rows"></div><button type="button" class="secondary" data-action="add-option">添加选项</button></div>
    <div id="multi-config" class="stack"><div class="grid-two">${limit('minSelect', '最少选择')}${limit('maxSelect', '最多选择')}</div>${limit('exactSelect', '必须选择')}</div>
    <div class="grid-two" id="text-config">${limit('minLength', '最短文本')}${limit('maxLength', '最长文本')}</div>
    <div id="number-config" class="stack"><div class="grid-two">${limit('min', '最小数字', 'any')}${limit('max', '最大数字', 'any')}</div><label class="check"><input name="integer" type="checkbox" ${question?.validation?.integer ? 'checked' : ''}>仅整数</label></div>
    <div id="rating-config" class="grid-two"><label>最低分<input name="ratingMin" type="number" min="1" max="10" step="1" value="${type === 'rating' ? question.validation.min : 1}"></label><label>最高分<input name="ratingMax" type="number" min="1" max="10" step="1" value="${type === 'rating' ? question.validation.max : 5}"></label></div></section>
    <section class="question-section" id="rules-config"><h3>跳转规则</h3><div id="rule-rows" class="editor-rows"></div><button type="button" class="secondary" data-action="add-rule">+ 添加跳转规则</button></section>
    ${onSave ? '<label>保存方式<select name="saveMode"><option value="new">创建新版本</option><option value="overwrite">覆盖选中版本</option></select></label><p class="hint">覆盖会更新本人问卷中使用该版本的题目；已发布问卷会生成新快照，历史答卷保留。其他用户导入的副本不受影响。</p>' : ''}`, async (form) => {
    const title = form.elements.title.value.trim();
    if (!title) throw new Error('请输入题目内容');
    const data = { qid: question ? currentQid : '__new_question__', type, title, required: form.elements.required.checked, options: [], validation: {}, jumpRules: [],
      ...(question?.libraryQuestionId && { libraryQuestionId: question.libraryQuestionId, questionVersionId: question.questionVersionId }) };
    if (type === 'single' || type === 'multi') {
      if (!options.length || options.some((item) => !item.trim())) throw new Error('请填写所有选项文字');
      data.options = options.map((item, index) => ({ id: optionLetter(index), text: item.trim() }));
    }
    const numericFields = type === 'multi' ? ['minSelect', 'maxSelect', 'exactSelect'] : type === 'text' ? ['minLength', 'maxLength'] : type === 'number' ? ['min', 'max'] : [];
    for (const field of numericFields) if (form.elements[field].value !== '') data.validation[field] = Number(form.elements[field].value);
    if (type === 'rating') {
      const min = Number(form.elements.ratingMin.value);
      const max = Number(form.elements.ratingMax.value);
      if (!form.elements.ratingMin.value || !form.elements.ratingMax.value ||
          !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 10 || min >= max) {
        throw new Error('评分范围须为 1～10 内的整数，且最高分大于最低分');
      }
      data.validation = { min, max, integer: true };
    }
    if (type === 'multi' && data.validation.exactSelect !== undefined &&
        ((data.validation.minSelect !== undefined && data.validation.exactSelect < data.validation.minSelect) ||
         (data.validation.maxSelect !== undefined && data.validation.exactSelect > data.validation.maxSelect))) {
      throw new Error('必须选择的数量与最少/最多选择冲突');
    }
    if (type === 'number') data.validation.integer = form.elements.integer.checked;
    data.jumpRules = rules.map((rule, index) => {
      if (!rule.target) throw new Error(`请选择第 ${index + 1} 条规则的目标`);
      let when;
      if (type === 'number' || type === 'rating') {
        if (rule.op === 'between') {
          if (rule.min === '' || rule.max === '' || Number(rule.min) > Number(rule.max)) throw new Error(`请填写第 ${index + 1} 条规则的有效区间`);
          when = { op: 'between', min: Number(rule.min), max: Number(rule.max) };
        } else {
          if (rule.value === '' || !Number.isFinite(Number(rule.value))) throw new Error(`请填写第 ${index + 1} 条规则的数值`);
          when = { op: rule.op, value: Number(rule.value) };
        }
      } else {
        if (!rule.choices.length || rule.choices.some((choice) => choice < 0 || choice >= data.options.length)) throw new Error(`请选择第 ${index + 1} 条规则的选项`);
        const ids = rule.choices.map((choice) => data.options[choice].id);
        when = type === 'single' ? { optionId: ids[0] } : rule.mode === 'any'
          ? { containsAnyOptionIds: ids } : rule.mode === 'all'
            ? { containsAllOptionIds: ids } : rule.mode === 'exact'
              ? { exactOptionIds: ids } : rule.mode === 'exclude'
                ? { excludesOptionIds: ids } : { containsOptionId: ids[0] };
      }
      return { id: `r${index + 1}`, when, targetQid: rule.target };
    });
    if (onSave) {
      const { type, title, required, options, validation } = data;
      await onSave({ type, title, required, ...(options.length && { options }),
        ...(Object.keys(validation).length && { validation }) }, form.elements.saveMode.value);
      return;
    }
    const questions = [...state.survey.draftQuestions];
    if (question) questions[questions.findIndex((item) => item.qid === question.qid)] = data;
    else questions.push(data);
    await saveQuestions(questions);
  });
  const fields = $('#dialog-fields');
  const renderRules = () => {
    const surveyQuestions = state.survey?.draftQuestions || [];
    const targets = surveyQuestions.filter((item) => !question || item.qid !== currentQid);
    const currentIndex = question ? surveyQuestions.findIndex((item) => item.qid === currentQid) : -1;
    const next = currentIndex < 0 ? null : surveyQuestions[currentIndex + 1];
    fields.querySelector('#rule-rows').innerHTML = rules.map((rule, index) => `<div class="rule-row" data-rule="${index}">
      ${type === 'multi' ? `<select data-field="mode" aria-label="第 ${index + 1} 条规则的匹配方式">${[['single', '包含单个选项'], ['any', '包含任一选项'], ['all', '同时包含全部'], ['exact', '恰好选择这些'], ['exclude', '未选择任何指定选项']].map(([value, label]) => `<option value="${value}" ${rule.mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select>` : ''}
      ${type === 'number' || type === 'rating' ? `<select data-field="condition" aria-label="第 ${index + 1} 条规则的条件">${[['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'], ['eq', '等于'], ['between', '介于（含边界）']].map(([value, label]) => `<option value="${value}" ${rule.op === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
      ${rule.op === 'between' ? `<div class="range-inputs"><input data-field="min" type="number" step="any" placeholder="最小值" aria-label="区间最小值" value="${escapeHtml(rule.min)}"><input data-field="max" type="number" step="any" placeholder="最大值" aria-label="区间最大值" value="${escapeHtml(rule.max)}"></div>` : `<input data-field="value" type="number" step="any" placeholder="18" aria-label="第 ${index + 1} 条规则的数值" value="${escapeHtml(rule.value)}">`}` : rule.mode === 'single' || type === 'single'
        ? `<select data-field="condition" aria-label="第 ${index + 1} 条规则的选项"><option value="">选择选项</option>${options.map((item, position) => `<option value="${position}" ${rule.choices[0] === position ? 'selected' : ''}>${optionLetter(position)} (${escapeHtml(item)})</option>`).join('')}</select>`
        : `<div class="rule-options" role="group" aria-label="第 ${index + 1} 条规则的选项">${options.map((item, position) => `<label class="check"><input type="checkbox" data-field="choice" value="${position}" ${rule.choices.includes(position) ? 'checked' : ''}>${optionLetter(position)} (${escapeHtml(item)})</label>`).join('')}</div>`}
      <select data-field="target" aria-label="第 ${index + 1} 条规则的目标"><option value="">选择目标</option>${next ? `<option value="${escapeHtml(next.qid)}" ${rule.target === next.qid ? 'selected' : ''}>顺序下一题</option>` : ''}${targets.filter((item) => item.qid !== next?.qid).map((item) => `<option value="${escapeHtml(item.qid)}" ${rule.target === item.qid ? 'selected' : ''}>第${escapeHtml(item.qid)}题</option>`).join('')}</select>
      <button type="button" class="secondary remove-row" data-action="remove-rule" data-index="${index}" aria-label="删除第 ${index + 1} 条规则" title="删除规则">×</button></div>`).join('');
  };
  const renderOptions = () => {
    fields.querySelector('#option-rows').innerHTML = options.map((item, index) => `<div class="option-row"><span class="option-id">${optionLetter(index)}</span><input data-option="${index}" value="${escapeHtml(item)}" aria-label="选项 ${optionLetter(index)} 的文字" placeholder="选项文字"><button type="button" class="secondary remove-row" data-action="remove-option" data-index="${index}" aria-label="删除选项 ${optionLetter(index)}" title="删除选项">×</button></div>`).join('');
    renderRules();
  };
  const renderType = () => {
    fields.querySelector('#options-config').hidden = !['single', 'multi'].includes(type);
    fields.querySelector('#multi-config').hidden = type !== 'multi';
    fields.querySelector('#text-config').hidden = type !== 'text';
    fields.querySelector('#number-config').hidden = type !== 'number';
    fields.querySelector('#rating-config').hidden = type !== 'rating';
    fields.querySelectorAll('#rating-config input').forEach((input) => { input.disabled = type !== 'rating'; });
    fields.querySelector('#rules-config').hidden = !!onSave || type === 'text';
    renderOptions();
  };
  fields.oninput = (event) => {
    if (event.target.matches('[data-option]')) { options[Number(event.target.dataset.option)] = event.target.value; renderRules(); }
    if (['value', 'min', 'max'].includes(event.target.dataset.field)) rules[Number(event.target.closest('[data-rule]').dataset.rule)][event.target.dataset.field] = event.target.value;
  };
  fields.onchange = (event) => {
    if (event.target.name === 'type') { type = event.target.value; rules = []; renderType(); }
    const index = Number(event.target.closest('[data-rule]')?.dataset.rule);
    if (event.target.dataset.field === 'mode') { rules[index].mode = event.target.value; rules[index].choices = []; renderRules(); }
    if (event.target.dataset.field === 'condition') {
      if (type === 'number' || type === 'rating') { rules[index].op = event.target.value; renderRules(); }
      else rules[index].choices = event.target.value === '' ? [] : [Number(event.target.value)];
    }
    if (event.target.dataset.field === 'choice') {
      const choice = Number(event.target.value);
      rules[index].choices = event.target.checked ? [...rules[index].choices, choice] :
        rules[index].choices.filter((item) => item !== choice);
    }
    if (event.target.dataset.field === 'target') rules[index].target = event.target.value;
  };
  fields.onclick = (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'add-option') { options.push(''); renderOptions(); fields.querySelector(`[data-option="${options.length - 1}"]`).focus(); }
    if (button.dataset.action === 'remove-option') {
      const index = Number(button.dataset.index);
      options.splice(index, 1);
      rules = rules.map((rule) => ({ ...rule, choices: rule.choices.filter((choice) => choice !== index)
        .map((choice) => choice > index ? choice - 1 : choice) })).filter((rule) => rule.choices.length || type === 'number');
      renderOptions();
    }
    if (button.dataset.action === 'add-rule') { rules.push({ mode: 'single', choices: [], op: 'gte', value: '', min: '', max: '', target: '' }); renderRules(); }
    if (button.dataset.action === 'remove-rule') { rules.splice(Number(button.dataset.index), 1); renderRules(); }
  };
  renderType();
}

function renderLibrary() {
  const selecting = state.libraryManaging || state.libraryMode === 'insert';
  const groups = [{ id: 'default', name: '默认题库' },
    ...state.banks.map((bank) => ({ id: bank._id, name: bank.name }))];
  $('#library-back').hidden = state.libraryMode !== 'insert';
  $('#manage-library').hidden = state.libraryMode === 'insert';
  $('#manage-library').textContent = state.libraryManaging ? '完成管理' : '管理题目';
  $('#library-toolbar').hidden = !state.libraryManaging;
  $('#library-add-toolbar').hidden = state.libraryMode !== 'insert';
  $('#library-target-bank').innerHTML = groups.map((group) =>
    `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join('');
  $('#library-list').innerHTML = groups.map((group) => {
    const items = state.library.filter((item) => (item.bankId || 'default') === group.id);
    return `<section class="bank-group" data-bank="${group.id}"><div class="section-head small"><h2>${escapeHtml(group.name)} <small>(${items.length})</small></h2><div class="actions">
      ${selecting && items.length ? '<label class="check"><input type="checkbox" data-select-all>全选本题库</label>' : ''}
      ${group.id !== 'default' && state.libraryMode !== 'insert' ? `<button type="button" class="secondary" data-rename-bank="${group.id}">重命名</button><button type="button" class="secondary" data-delete-bank="${group.id}">删除空题库</button>` : ''}</div></div>
      ${items.length ? items.map((item) => `<div class="row" data-library-id="${item._id}">
        ${selecting ? `<input type="checkbox" class="row-check" data-select-question value="${item._id}" aria-label="选择${escapeHtml(item.currentVersion.content.title)}">` : ''}
        <div class="row-main"><div class="row-title">${escapeHtml(item.currentVersion.content.title)}</div>
        <div class="row-sub">${escapeHtml(item.currentVersion.content.type)} · 默认 v${item.currentVersion.version}</div>
        <label>题目版本<select data-version>${item.versions.map((version) => `<option value="${version._id}" ${version._id === item.currentVersionId ? 'selected' : ''}>v${version.version} · ${escapeHtml(version.content.title)}</option>`).join('')}</select></label></div>
        <div class="row-actions">${state.libraryMode !== 'insert' ? '<button type="button" class="secondary" data-library-action="edit">编辑</button><button type="button" class="secondary" data-library-action="restore">设为默认版本</button><button type="button" class="secondary" data-library-action="share">分享链接</button><button type="button" class="secondary" data-library-action="usage">使用情况</button><button type="button" class="secondary" data-library-action="stats">跨问卷统计</button>' : ''}</div></div>`).join('') : '<p class="muted">暂无题目</p>'}</section>`;
  }).join('');
}
async function openLibrary(mode = 'manage') {
  state.libraryMode = mode;
  state.libraryManaging = false;
  [state.banks, state.library] = await Promise.all([
    api('/api/question-banks'), api('/api/library-questions')
  ]);
  const histories = await Promise.all(state.library.map((item) =>
    api(`/api/library-questions/${item._id}/versions`)));
  state.library.forEach((item, index) => { item.versions = histories[index]; });
  renderLibrary();
  $('#library-detail').hidden = true;
  show('library');
}
function bankDialog(name = '', bankId = null) {
  openDialog(bankId ? '重命名题库' : '新建题库', `<label>题库名称<input name="name" required maxlength="120" value="${escapeHtml(name)}"></label>`, async (form) => {
    const body = { name: form.elements.name.value.trim() };
    if (bankId) await send(`/api/question-banks/${bankId}`, 'PATCH', body);
    else await send('/api/question-banks', 'POST', body);
    await openLibrary(state.libraryMode);
  });
}
async function saveToLibrary(qid) {
  state.banks = await api('/api/question-banks');
  openDialog('存入题库', `<label>题库<select name="bankId"><option value="default">默认题库</option>${state.banks.map((bank) =>
    `<option value="${bank._id}">${escapeHtml(bank.name)}</option>`).join('')}</select></label>`, async (form) => {
    const bankId = form.elements.bankId.value;
    await send(bankId === 'default' ? '/api/library-questions' : `/api/question-banks/${bankId}/questions`, 'POST',
      { surveyId: state.survey._id, qid });
    await openSurvey(state.survey._id);
    notice('题目已保存到题库', true);
  });
}

function normalizePublicId(value) {
  const trimmed = value.trim();
  try { const url = new URL(trimmed); return url.searchParams.get('survey') || url.pathname.split('/').filter(Boolean).at(-1); }
  catch { return trimmed; }
}
async function openPublic(value) {
  const publicId = normalizePublicId(value);
  if (!publicId) throw new Error('请输入公开 ID');
  state.publicSurvey = await api(`/api/public/surveys/${encodeURIComponent(publicId)}`);
  state.answers = new Map();
  state.history = [];
  state.currentQid = state.publicSurvey.questions[0]?.qid || null;
  state.submissionId = crypto.randomUUID();
  $('#open-form').elements.publicId.value = publicId;
  $('#fill-title').textContent = state.publicSurvey.title;
  $('#fill-description').textContent = state.publicSurvey.description || '';
  $('#anonymous').checked = false;
  $('#anonymous').disabled = !state.publicSurvey.allowAnonymous;
  $('#fill-area').hidden = false;
  show('fill');
  renderCurrent();
}
function renderCurrent() {
  const survey = state.publicSurvey;
  const qid = state.currentQid;
  const question = survey?.questions.find((item) => item.qid === qid);
  $('#answer-form').hidden = !question;
  $('#submission-settings').hidden = !!question;
  if (!question) {
    $('#fill-progress').textContent = '已完成';
    return;
  }
  $('#fill-progress').textContent = `第 ${state.history.length + 1} 题`;
  $('#fill-back').disabled = state.history.length === 0;
  const old = state.answers.get(qid)?.value;
  const name = escapeHtml(question.qid);
  let input;
  if (question.type === 'single' || question.type === 'multi') {
    input = (question.options || []).map((option) => `<label class="choice"><input type="${question.type === 'single' ? 'radio' : 'checkbox'}" name="answer" value="${escapeHtml(option.id)}" ${question.type === 'single' ? old === option.id ? 'checked' : '' : Array.isArray(old) && old.includes(option.id) ? 'checked' : ''}>${escapeHtml(option.text)}</label>`).join('');
  } else if (question.type === 'text') input = `<textarea name="answer" ${question.required ? 'required' : ''}>${escapeHtml(old ?? '')}</textarea>`;
  else if (question.type === 'rating') input = `<div class="rating-scale" role="group" aria-label="选择评分">${Array.from(
    { length: question.validation.max - question.validation.min + 1 }, (_, index) => {
      const score = question.validation.min + index;
      return `<label class="rating-choice"><input type="radio" name="answer" value="${score}" ${old === score ? 'checked' : ''}><span>${score}</span></label>`;
    }).join('')}</div>`;
  else input = `<input name="answer" type="number" step="${question.validation?.integer ? '1' : 'any'}" value="${old ?? ''}" ${question.required ? 'required' : ''}>`;
  $('#current-question').innerHTML = `<h2 class="question-heading">${escapeHtml(question.title)}${question.required ? ' *' : ''}</h2><div class="question-help">${name}</div>${input}`;
  $('#fill-next').textContent = '下一题';
}
function readAnswer(question) {
  const form = $('#answer-form');
  let value;
  if (question.type === 'single') value = form.querySelector('input[name="answer"]:checked')?.value;
  else if (question.type === 'multi') value = [...form.querySelectorAll('input[name="answer"]:checked')].map((item) => item.value);
  else if (question.type === 'rating') value = form.querySelector('input[name="answer"]:checked')?.value;
  else value = form.elements.answer.value;
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
    if (question.required) throw new Error('请填写此题');
    return null;
  }
  if (question.type === 'number' || question.type === 'rating') value = Number(value);
  return { qid: question.qid, type: question.type, value };
}
async function nextQuestion() {
  const qid = state.currentQid;
  const question = state.publicSurvey.questions.find((item) => item.qid === qid);
  const current = readAnswer(question);
  const pathAnswers = state.history.map((item) => state.answers.get(item)).filter(Boolean);
  if (current) pathAnswers.push(current);
  const result = await send(`/api/public/surveys/${encodeURIComponent(state.publicSurvey.publicId)}/next`, 'POST', {
    versionId: state.publicSurvey.versionId, currentQid: qid, answers: pathAnswers
  });
  if (current) state.answers.set(qid, current); else state.answers.delete(qid);
  state.history.push(qid);
  state.currentQid = result.nextQid;
  renderCurrent();
}
async function submitResponse() {
  const answers = state.history.map((qid) => state.answers.get(qid)).filter(Boolean);
  const result = await send(`/api/public/surveys/${encodeURIComponent(state.publicSurvey.publicId)}/submit`, 'POST', {
    versionId: state.publicSurvey.versionId, clientSubmissionId: state.submissionId,
    anonymous: $('#anonymous').checked, answers
  });
  $('#submission-settings').hidden = true;
  $('#fill-progress').textContent = '已提交';
  notice(`提交成功，答卷编号：${result.id}`, true);
}
function renderStatistics(data) {
  $('#stats-version').value = data.versionId;
  $('#stats-count').textContent = `${data.totalResponses} 份答卷`;
  $('#stats-all').hidden = !data.question;
  $('#stats-list').innerHTML = (data.question ? [data.question] : data.questions).map((question) => {
    let body;
    if (question.counts) body = question.counts.map((item) => `<div class="stats-line"><span>${escapeHtml(item.optionId)}. ${escapeHtml(item.text)}</span><strong>${item.count}</strong></div>`).join('');
    else if (question.values) body = question.values.length ? question.values.map((value) => `<div class="stats-text">${escapeHtml(value)}</div>`).join('') : '<p>暂无文本答案</p>';
    else body = '';
    if (question.type === 'number' || question.type === 'rating') body = `<div class="stats-line"><span>平均值</span><strong>${question.avg ?? '—'}</strong></div><div class="stats-line"><span>最小值</span><strong>${question.min ?? '—'}</strong></div><div class="stats-line"><span>最大值</span><strong>${question.max ?? '—'}</strong></div>${body}`;
    return `<div class="stats-item"><div class="section-head small"><h2>${escapeHtml(question.title)}</h2>${data.question ? '' : `<button type="button" class="secondary" data-stats-qid="${escapeHtml(question.qid)}">查看单题</button>`}</div>${question.count !== undefined ? `<div class="stats-line"><span>本题答题数</span><strong>${question.count}</strong></div>` : ''}${body}</div>`;
  }).join('');
  show('stats');
}
async function openStatistics(versionId = null, qid = null) {
  const id = state.survey._id;
  const versions = await api(`/api/surveys/${id}/versions`);
  $('#stats-version').innerHTML = versions.map((item) => `<option value="${escapeHtml(item.versionId)}">v${item.version}</option>`).join('');
  const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
  renderStatistics(await api(`/api/surveys/${id}/statistics${qid ? `/${encodeURIComponent(qid)}` : ''}${query}`));
}

$('#auth-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => {
  const form = event.currentTarget;
  state.user = await send(`/api/auth/${state.authMode}`, 'POST', { username: form.elements.username.value, password: form.elements.password.value });
  await refreshSurveys();
  const params = new URLSearchParams(location.search);
  if (params.has('import')) {
    await openLibrary();
    $('#import-question').elements.link.value = location.href;
  } else if (params.has('survey')) await openPublic(params.get('survey'));
  else show('mine');
}); });
$('#auth-toggle').addEventListener('click', () => { state.authMode = state.authMode === 'login' ? 'register' : 'login'; $('#auth-view h1').textContent = state.authMode === 'login' ? '登录' : '注册'; $('#auth-submit').textContent = state.authMode === 'login' ? '登录' : '注册'; $('#auth-toggle').textContent = state.authMode === 'login' ? '创建账户' : '返回登录'; });
$('#logout').addEventListener('click', () => run(async () => { await send('/api/auth/logout', 'POST'); state.user = null; state.survey = null; show('auth'); }));
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => run(async () => { const view = button.dataset.view; if (view === 'mine') await refreshSurveys(); if (view === 'library') await openLibrary(); else show(view); })));
$('#new-bank').addEventListener('click', () => bankDialog());
$('#manage-library').addEventListener('click', () => {
  state.libraryManaging = !state.libraryManaging;
  renderLibrary();
});
$('#library-back').addEventListener('click', () => run(() => openSurvey(state.survey._id)));
$('#choose-library').addEventListener('click', () => run(() => openLibrary('insert')));
$('#import-question').addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget; run(async () => {
  const raw = form.elements.link.value.trim();
  let token = raw;
  try { token = new URL(raw).searchParams.get('import') || raw; } catch { /* Accept a raw token. */ }
  await send('/api/library-questions/import', 'POST', { token });
  form.reset();
  await openLibrary();
  notice('题目已导入默认题库；以后可独立修改', true);
}); });
$('#library-list').addEventListener('click', (event) => run(async () => {
  const button = event.target.closest('button');
  if (!button || (!button.dataset.renameBank && !button.dataset.deleteBank)) return;
  const bank = state.banks.find((item) => item._id === button.dataset.renameBank || item._id === button.dataset.deleteBank);
  if (button.dataset.renameBank) bankDialog(bank.name, bank._id);
  if (button.dataset.deleteBank && confirm(`删除空题库“${bank.name}”？`)) {
    await send(`/api/question-banks/${bank._id}`, 'DELETE'); await openLibrary(state.libraryMode);
  }
}));
$('#library-list').addEventListener('change', (event) => {
  if (!event.target.matches('[data-select-all]')) return;
  event.target.closest('[data-bank]').querySelectorAll('[data-select-question]').forEach((input) => {
    input.checked = event.target.checked;
  });
});
const selectedLibraryRows = () => [...$('#library-list').querySelectorAll('[data-library-id]')]
  .filter((row) => row.querySelector('[data-select-question]')?.checked);
$('#move-library').addEventListener('click', () => run(async () => {
  const ids = selectedLibraryRows().map((row) => row.dataset.libraryId);
  if (!ids.length) throw new Error('请先选择题目');
  const target = $('#library-target-bank').value;
  await send('/api/library-questions/batch', 'POST', { ids, action: 'move',
    bankId: target === 'default' ? null : target });
  await openLibrary();
  notice(`已移动 ${ids.length} 道题`, true);
}));
$('#delete-library').addEventListener('click', () => run(async () => {
  const ids = selectedLibraryRows().map((row) => row.dataset.libraryId);
  if (!ids.length) throw new Error('请先选择题目');
  if (!confirm(`从题库删除 ${ids.length} 道题？已保存的问卷和答卷不会删除。`)) return;
  await send('/api/library-questions/batch', 'POST', { ids, action: 'archive' });
  await openLibrary();
  notice(`已从题库移除 ${ids.length} 道题`, true);
}));
$('#add-library-selected').addEventListener('click', () => run(async () => {
  const questionVersionIds = selectedLibraryRows().map((row) => row.querySelector('[data-version]').value);
  if (!questionVersionIds.length) throw new Error('请先选择题目');
  await send(`/api/surveys/${state.survey._id}/questions/from-library/batch`, 'POST', { questionVersionIds });
  await openSurvey(state.survey._id);
  notice(`已添加 ${questionVersionIds.length} 道题`, true);
}));
$('#library-list').addEventListener('click', (event) => run(async () => {
  const button = event.target.closest('[data-library-action]');
  if (!button) return;
  const row = button.closest('[data-library-id]');
  const item = state.library.find((entry) => entry._id === row.dataset.libraryId);
  const selectedId = row.querySelector('[data-version]').value;
  const version = item.versions.find((entry) => entry._id === selectedId);
  const base = `/api/library-questions/${item._id}`;
  if (button.dataset.libraryAction === 'edit') {
    questionDialog({ qid: '1', ...version.content }, async (content, mode) => {
      if (mode === 'overwrite') {
        if (!confirm('覆盖后，本人问卷中使用此版本的题目会更新；已发布问卷将生成新快照。确定覆盖？')) return;
        await send(`${base}/versions/${selectedId}`, 'PUT', { question: content });
      } else {
        await send(`${base}/versions`, 'POST', { question: content, sourceVersionId: selectedId });
      }
      await openLibrary(state.libraryMode);
    });
  } else if (button.dataset.libraryAction === 'restore') {
    if (!confirm(`将 v${version.version} 设为默认版本？不会新增版本。`)) return;
    await send(`${base}/versions/${selectedId}/restore`, 'POST');
    await openLibrary(state.libraryMode);
  } else if (button.dataset.libraryAction === 'share') {
    const { token } = await send(`${base}/share-link`, 'POST');
    const link = new URL('/', location.origin);
    link.searchParams.set('import', token);
    openDialog('题目分享链接', `<label>复制链接发给其他用户<input name="link" readonly value="${escapeHtml(link.toString())}"></label><p class="hint">可供多人分别导入为独立副本。重新生成链接会使旧链接失效，已导入的副本不受影响。</p>`, async () => {
      await navigator.clipboard.writeText(link.toString());
      notice('分享链接已复制', true);
    });
    $('#dialog-form button[type="submit"]').textContent = '复制链接';
  } else {
    const data = await api(`${base}/${button.dataset.libraryAction === 'usage' ? 'usage' : 'statistics'}`);
    const detail = $('#library-detail');
    detail.hidden = false;
    detail.innerHTML = button.dataset.libraryAction === 'usage'
      ? `<h2>使用情况</h2>${[...data.drafts.map((x) => `草稿：${x.title} / 第${x.qid}题 / 题目版本 ${x.questionVersionId}`),
        ...data.published.map((x) => `已发布：${x.title} v${x.surveyVersion} / 第${x.qid}题 / 题目版本 ${x.questionVersionId}`)]
        .map((x) => `<p>${escapeHtml(x)}</p>`).join('') || '<p>尚未使用</p>'}`
      : `<h2>跨问卷统计</h2>${data.versions.flatMap((x) =>
        (x.revisions || [x]).map((part) => `<p>v${x.version}${x.revisions ? `（内容修订 ${part.contentRevision}）` : ''} ${escapeHtml(part.title)}：纳入 ${part.surveyVersionCount} 个问卷版本，${part.answerCount} 人回答；${part.counts.length
          ? part.counts.map((c) => `${escapeHtml(c.text)} ${c.count} 次`).join('，')
          : part.type === 'text' ? escapeHtml(part.values.join('；')) : `平均值 ${part.avg ?? '—'}`}</p>`)).join('')}`;
  }
}));
$('#new-survey').addEventListener('click', surveyDialog);
$('#survey-list').addEventListener('click', (event) => run(async () => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.open) await openSurvey(button.dataset.open);
  if (button.dataset.fill) await openPublic(button.dataset.fill);
  if (button.dataset.stats) { state.survey = await api(`/api/surveys/${button.dataset.stats}`); await openStatistics(); }
}));
$('#add-question').addEventListener('click', () => questionDialog());
$('#edit-published').addEventListener('click', () => run(async () => {
  await api(`/api/surveys/${state.survey._id}/draft`);
  await openSurvey(state.survey._id);
}));
$('#question-list').addEventListener('click', (event) => run(async () => {
  const button = event.target.closest('button'); if (!button) return;
  const qid = button.dataset.edit || button.dataset.delete || button.dataset.saveLibrary || button.dataset.qid;
  if (!qid) return;
  if (button.dataset.edit) questionDialog(state.survey.draftQuestions.find((item) => item.qid === qid));
  else if (button.dataset.saveLibrary) await saveToLibrary(qid);
  else if (button.dataset.delete && confirm(`删除题目 ${qid}？指向该题的跳转规则也会删除。`)) {
    await saveQuestions(state.survey.draftQuestions.filter((item) => item.qid !== qid));
  } else if (button.dataset.move) {
    const questions = [...state.survey.draftQuestions];
    const index = questions.findIndex((item) => item.qid === qid);
    const other = index + (button.dataset.move === 'up' ? -1 : 1);
    if (other < 0 || other >= questions.length) return;
    [questions[index], questions[other]] = [questions[other], questions[index]];
    await saveQuestions(questions);
  }
}));
$('#publish').addEventListener('click', () => run(async () => { if (!confirm('确定发布当前版本？')) return; const result = await send(`/api/surveys/${state.survey._id}/publish`, 'POST'); await openSurvey(state.survey._id); notice(`v${result.version} 发布成功`, true); }));
$('#close-survey').addEventListener('click', () => run(async () => {
  if (!confirm('关闭后将不能再填写或编辑该问卷。确定关闭？')) return;
  await send(`/api/surveys/${state.survey._id}/close`, 'POST');
  await openSurvey(state.survey._id);
  notice('问卷已关闭', true);
}));
$('#open-fill').addEventListener('click', () => run(() => openPublic(state.survey.publicId)));
$('#copy-link').addEventListener('click', () => run(async () => {
  const url = new URL('/', location.origin);
  url.searchParams.set('survey', state.survey.publicId);
  await navigator.clipboard.writeText(url.toString());
  notice('填写链接已复制', true);
}));
$('#open-stats').addEventListener('click', () => run(() => openStatistics()));
$('#stats-version').addEventListener('change', (event) => run(() => openStatistics(event.currentTarget.value)));
$('#stats-list').addEventListener('click', (event) => run(async () => {
  const qid = event.target.closest('[data-stats-qid]')?.dataset.statsQid;
  if (qid) await openStatistics($('#stats-version').value, qid);
}));
$('#stats-all').addEventListener('click', () => run(() => openStatistics($('#stats-version').value)));
$('#stats-back').addEventListener('click', () => run(() => openSurvey(state.survey._id)));
$('#open-form').addEventListener('submit', (event) => { event.preventDefault(); run(() => openPublic(event.currentTarget.elements.publicId.value)); });
$('#answer-form').addEventListener('submit', (event) => { event.preventDefault(); run(nextQuestion); });
$('#fill-back').addEventListener('click', () => { if (!state.history.length) return; state.currentQid = state.history.pop(); renderCurrent(); });
$('#review-back').addEventListener('click', () => { if (!state.history.length) return; state.currentQid = state.history.pop(); renderCurrent(); });
$('#submit-response').addEventListener('click', () => run(submitResponse));
$('#dialog-cancel').addEventListener('click', () => $('#dialog').close());
$('#dialog-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => { await state.dialogAction(event.currentTarget); $('#dialog').close(); }); });

run(async () => {
  try {
    state.user = await api('/api/auth/me'); await refreshSurveys();
    const params = new URLSearchParams(location.search);
    if (params.has('import')) {
      await openLibrary();
      $('#import-question').elements.link.value = location.href;
    } else if (params.has('survey')) await openPublic(params.get('survey'));
    else show('mine');
  }
  catch (error) { if (error.code !== 'LOGIN_REQUIRED') throw error; show('auth'); }
});
