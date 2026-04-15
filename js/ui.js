// Shared UI utilities and question renderers
const UI = (() => {

  // ── Toast ─────────────────────────────────────────────────────────────────
  let _toastEl = null;
  function _getToastContainer() {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'toast-container';
      document.body.appendChild(_toastEl);
    }
    return _toastEl;
  }

  function toast(message, type = 'default', duration = 2800) {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = message;
    _getToastContainer().appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  function confirm(message, confirmText = 'Confirm', cancelText = 'Cancel') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <p style="margin-bottom:1.5rem">${escapeHtml(message)}</p>
          <div class="modal-footer">
            <button class="btn btn-secondary" data-r="cancel">${cancelText}</button>
            <button class="btn btn-primary" data-r="ok">${confirmText}</button>
          </div>
        </div>`;
      overlay.addEventListener('click', e => {
        if (e.target === overlay) { overlay.remove(); resolve(false); }
      });
      overlay.querySelectorAll('[data-r]').forEach(btn => {
        btn.addEventListener('click', () => {
          overlay.remove();
          resolve(btn.dataset.r === 'ok');
        });
      });
      document.body.appendChild(overlay);
    });
  }

  function showModal(html, { onClose } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = html;
    overlay.appendChild(modal);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { overlay.remove(); onClose?.(); }
    });
    modal.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => { overlay.remove(); onClose?.(); });
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  // ── Escape HTML ───────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Question renderer ─────────────────────────────────────────────────────
  function renderQuestion(question, { onAnswer, showAnswer = false } = {}) {
    const el = document.createElement('div');
    el.className = 'question-card';
    el.dataset.qid = question.id;

    const typeLabels = {
      mcq: 'Multiple Choice', true_false: 'True / False',
      short_answer: 'Short Answer', long_answer: 'Long Answer', fill_blank: 'Fill in the Blank'
    };
    const diffColors = { easy: 'green', medium: 'yellow', hard: 'red' };

    el.innerHTML = `
      <div class="question-meta">
        <span class="badge badge-blue">${typeLabels[question.type] || question.type}</span>
        ${question.difficulty ? `<span class="badge badge-${diffColors[question.difficulty] || 'gray'}">${question.difficulty}</span>` : ''}
        ${question.topic_name ? `<span class="badge badge-gray">${escapeHtml(question.topic_name)}</span>` : ''}
        <span class="text-sm text-muted ms-auto">${question.marks || 1} mark${(question.marks || 1) !== 1 ? 's' : ''}</span>
      </div>
      <div class="question-text">${renderQuestionText(question)}</div>
      <div class="answer-area"></div>
      ${showAnswer ? renderAnswerReveal(question) : ''}
    `;

    const answerArea = el.querySelector('.answer-area');
    if (question.type !== 'fill_blank') {
      renderAnswerInput(question, answerArea, onAnswer, showAnswer);
    }
    if (question.type === 'fill_blank') {
      renderFillBlank(question, el, onAnswer, showAnswer);
    }

    return el;
  }

  function renderQuestionText(question) {
    if (question.type === 'fill_blank') return ''; // rendered separately
    return escapeHtml(question.question).replace(/\n/g, '<br>');
  }

  function renderAnswerInput(question, container, onAnswer, disabled = false) {
    if (question.type === 'mcq') {
      const list = document.createElement('div');
      list.className = 'options-list';
      (question.options || []).forEach(opt => {
        const item = document.createElement('div');
        const isSelected = question.user_answer === opt.id;
        item.className = 'option-item' + (isSelected ? ' selected' : '');
        item.dataset.optId = opt.id;
        item.innerHTML = `<span class="option-letter">${opt.id.toUpperCase()}</span><span>${escapeHtml(opt.text)}</span>`;
        if (!disabled) {
          item.addEventListener('click', () => {
            list.querySelectorAll('.option-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            onAnswer?.(question.id, opt.id);
          });
          item.style.cursor = 'pointer';
        }
        list.appendChild(item);
      });
      container.appendChild(list);

    } else if (question.type === 'true_false') {
      const div = document.createElement('div');
      div.className = 'tf-buttons';
      ['true', 'false'].forEach(val => {
        const btn = document.createElement('button');
        const isSelected = question.user_answer === val;
        btn.className = `tf-btn ${val}-btn${isSelected ? ' selected' : ''}`;
        btn.textContent = val === 'true' ? 'True' : 'False';
        btn.disabled = disabled;
        if (!disabled) {
          btn.addEventListener('click', () => {
            div.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            onAnswer?.(question.id, val);
          });
        }
        div.appendChild(btn);
      });
      container.appendChild(div);

    } else if (question.type === 'short_answer') {
      const ta = document.createElement('textarea');
      ta.className = 'short-answer-area';
      ta.placeholder = 'Type your answer here…';
      ta.value = question.user_answer || '';
      ta.disabled = disabled;
      ta.addEventListener('input', () => onAnswer?.(question.id, ta.value));
      container.appendChild(ta);

    } else if (question.type === 'long_answer') {
      const wrap = document.createElement('div');
      const ta = document.createElement('textarea');
      ta.className = 'short-answer-area';
      ta.style.minHeight = '180px';
      ta.placeholder = 'Write your full answer here. Use multiple paragraphs as needed.';
      ta.value = question.user_answer || '';
      ta.disabled = disabled;
      const counter = document.createElement('div');
      counter.style.cssText = 'font-size:.72rem;color:var(--text-muted);text-align:right;margin-top:.25rem';
      const updateCounter = () => {
        const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
        counter.textContent = `${words} word${words !== 1 ? 's' : ''}`;
      };
      updateCounter();
      ta.addEventListener('input', () => { onAnswer?.(question.id, ta.value); updateCounter(); });
      wrap.appendChild(ta);
      wrap.appendChild(counter);
      container.appendChild(wrap);
    }
  }

  function renderFillBlank(question, parentEl, onAnswer, disabled = false) {
    const textEl = parentEl.querySelector('.question-text');
    textEl.innerHTML = '';
    textEl.className = 'question-text fill-blank-text';

    const parts = question.question.split('___');
    const inputs = [];
    parts.forEach((part, i) => {
      textEl.appendChild(document.createTextNode(part));
      if (i < parts.length - 1) {
        const inp = document.createElement('input');
        inp.className = 'blank-input';
        inp.type = 'text';
        inp.placeholder = '…';
        inp.disabled = disabled;
        inp.value = (Array.isArray(question.user_answer) && question.user_answer[i]) ? question.user_answer[i] : '';
        inp.style.width = Math.max(80, (inp.placeholder.length + 6) * 9) + 'px';
        inp.addEventListener('input', () => {
          inp.style.width = Math.max(80, (inp.value.length + 6) * 9) + 'px';
          onAnswer?.(question.id, inputs.map(inp => inp.value));
        });
        inputs.push(inp);
        textEl.appendChild(inp);
      }
    });
  }

  function renderAnswerReveal(question) {
    if (question.grading.status !== 'graded') return '';
    const isAutoGraded = question.grading.graded_by === 'auto';
    const statusClass = (question.grading.score || 0) >= (question.grading.max_score || 1) ? 'correct' : 'wrong';

    let reveal = `<div class="answer-reveal answer-reveal-${statusClass}">`;
    if (isAutoGraded && question.correct_answer) {
      if (question.type === 'mcq' && question.options) {
        const opt = question.options.find(o => o.id === question.correct_answer);
        reveal += `<strong>Correct answer:</strong> ${escapeHtml(opt?.text || question.correct_answer)}`;
      } else {
        reveal += `<strong>Correct answer:</strong> ${escapeHtml(question.correct_answer)}`;
      }
    }
    if (question.grading.feedback) {
      reveal += `<div class="mt-1"><strong>Feedback:</strong> ${escapeHtml(question.grading.feedback)}</div>`;
    }
    if (question.answer_pointers?.length) {
      reveal += `<div class="mt-1"><strong>Key points:</strong><ul>${question.answer_pointers.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>`;
    }
    reveal += `<div class="grade-badge">${question.grading.score ?? '—'} / ${question.grading.max_score || question.marks || 1}</div>`;
    reveal += '</div>';
    return reveal;
  }

  // ── Question dot grid ─────────────────────────────────────────────────────
  function renderQuestionGrid(questions, currentIndex, onClick) {
    const grid = document.createElement('div');
    grid.className = 'q-grid';
    questions.forEach((q, i) => {
      const dot = document.createElement('div');
      dot.className = 'q-dot';
      if (i === currentIndex) dot.classList.add('current');
      if (q.user_answer !== null) dot.classList.add('answered');
      if (q.flagged) dot.classList.add('flagged');
      if (q.grading.status === 'graded') {
        const maxScore = q.grading.max_score || q.marks || 1;
        dot.classList.add((q.grading.score || 0) >= maxScore ? 'graded-correct' : 'graded-wrong');
      }
      dot.textContent = i + 1;
      dot.title = `Q${i + 1}${q.topic_name ? ' · ' + q.topic_name : ''} (${typeLabels[q.type] || q.type})`;
      dot.addEventListener('click', () => onClick(i));
      grid.appendChild(dot);
    });
    return grid;
  }

  const typeLabels = {
    mcq: 'MCQ', true_false: 'T/F', short_answer: 'Short', long_answer: 'Long', fill_blank: 'Fill'
  };

  // ── File drop zone ─────────────────────────────────────────────────────────
  function setupFileDrop(element, onFile, accept = '.json') {
    element.addEventListener('dragover', e => { e.preventDefault(); element.classList.add('dragover'); });
    element.addEventListener('dragleave', () => element.classList.remove('dragover'));
    element.addEventListener('drop', e => {
      e.preventDefault();
      element.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    });
    element.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); });
      input.click();
    });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  function setupTabs(container) {
    const tabs = container.querySelectorAll('.tab');
    const panels = container.querySelectorAll('.tab-panel');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        container.querySelector(`.tab-panel[data-tab="${tab.dataset.tab}"]`)?.classList.add('active');
      });
    });
    if (tabs.length) tabs[0].click();
  }

  // ── Code block copy button ─────────────────────────────────────────────────
  function enhanceCodeBlocks() {
    document.querySelectorAll('.code-block').forEach(block => {
      if (block.querySelector('.copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        const code = block.querySelector('pre')?.textContent || block.textContent;
        await Export.copyToClipboard(code);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
      block.appendChild(btn);
    });
  }

  // ── Progress bar ──────────────────────────────────────────────────────────
  function updateProgress(labelEl, fillEl, answered, total) {
    if (labelEl) labelEl.textContent = `${answered} / ${total}`;
    if (fillEl) fillEl.style.width = total > 0 ? `${Math.round((answered / total) * 100)}%` : '0%';
  }

  return {
    toast, confirm, showModal, escapeHtml,
    renderQuestion, renderAnswerInput, renderFillBlank, renderAnswerReveal,
    renderQuestionGrid, setupFileDrop, setupTabs, enhanceCodeBlocks, updateProgress
  };
})();
