// Export / import utilities for the LLM pipelines
const Export = (() => {

  // Resolve a list of question IDs from a filter spec
  function resolveIds(quiz, filter) {
    if (Array.isArray(filter)) return filter;
    const qs = quiz.questions;
    switch (filter) {
      case 'all':          return qs.map(q => q.id);
      case 'flagged':      return qs.filter(q => q.flagged).map(q => q.id);
      case 'answered':     return qs.filter(q => q.user_answer !== null).map(q => q.id);
      case 'unanswered':   return qs.filter(q => q.user_answer === null).map(q => q.id);
      case 'ungraded':     return qs.filter(q => q.grading.status === 'ungraded' && q.user_answer !== null).map(q => q.id);
      case 'needs_remark': return qs.filter(q => q.grading.status === 'needs_remark').map(q => q.id);
      default:
        // 'topic:<name>'
        if (typeof filter === 'string' && filter.startsWith('topic:')) {
          const name = filter.slice(6);
          return qs.filter(q => q.topic_name === name).map(q => q.id);
        }
        return qs.map(q => q.id);
    }
  }

  // Build a grading export payload to paste into LLM chat
  function buildGradingPayload(quiz, filter = 'all') {
    const ids = resolveIds(quiz, filter);
    const questions = quiz.questions.filter(q => ids.includes(q.id) && q.user_answer !== null);

    return {
      grading_request: {
        quiz_id: quiz.id,
        quiz_title: quiz.title,
        exported_at: new Date().toISOString(),
        instructions: [
          "You are grading student answers. For each question below, fill in the grading object.",
          "Rules:",
          "- score: integer, 0 to max_score",
          "- feedback: 1-2 sentences explaining the grade",
          "- criteria_used: 'rubric' | 'correct_answer' | 'answer_pointers'",
          "- graded_by: always set to 'llm'",
          "- graded_at: current ISO 8601 timestamp",
          "Return ONLY a valid JSON object matching the grading_response schema. No markdown, no explanation."
        ].join(' '),
        response_schema: {
          grading_response: {
            quiz_id: "<string: copy from request>",
            graded_at: "<ISO timestamp>",
            grades: [
              {
                id: "<question id>",
                score: "<number>",
                max_score: "<number>",
                feedback: "<string>",
                criteria_used: "<rubric|correct_answer|answer_pointers>",
                graded_by: "llm"
              }
            ]
          }
        },
        questions: questions.map(q => {
          const out = {
            id: q.id,
            type: q.type,
            topic: q.topic_name || null,
            question: q.question,
            max_score: q.grading.max_score || q.marks || 1,
            user_answer: q.user_answer
          };
          if (q.type === 'mcq') {
            out.options = q.options;
            out.correct_answer = q.correct_answer;
          }
          if (q.type === 'true_false') {
            out.correct_answer = q.correct_answer;
          }
          if (q.rubric) out.rubric = q.rubric;
          if (q.answer_pointers?.length) out.answer_pointers = q.answer_pointers;
          if (q.blanks?.length) out.correct_blanks = q.blanks;
          return out;
        })
      }
    };
  }

  // Build a single-question grading payload
  function buildSingleGradingPayload(quiz, questionId) {
    return buildGradingPayload(quiz, [questionId]);
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    }
  }

  async function readJSONFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try { resolve(JSON.parse(e.target.result)); }
        catch { reject(new Error('Invalid JSON: could not parse file')); }
      };
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  return {
    resolveIds,
    buildGradingPayload,
    buildSingleGradingPayload,
    downloadJSON,
    downloadText,
    copyToClipboard,
    readJSONFile
  };
})();
