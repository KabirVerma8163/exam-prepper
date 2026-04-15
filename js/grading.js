// Grading and evaluation module
const Grading = (() => {

  function setManualGrade(quiz, questionId, { score, feedback, markNeedsRemark } = {}) {
    const q = quiz.questions.find(q => q.id === questionId);
    if (!q) return false;
    if (markNeedsRemark) {
      q.grading.status = 'needs_remark';
      return true;
    }
    q.grading.score = score;
    q.grading.max_score = q.grading.max_score || q.marks || 1;
    q.grading.feedback = feedback || null;
    q.grading.status = 'graded';
    q.grading.graded_by = 'manual';
    q.grading.criteria_used = 'manual';
    q.grading.graded_at = new Date().toISOString();
    return true;
  }

  function applyGradingResponse(quiz, gradingResponse) {
    const grades = gradingResponse?.grading_response?.grades || gradingResponse?.grades;
    if (!grades || !Array.isArray(grades)) {
      return { applied: 0, errors: ['Invalid grading response: missing grades array'] };
    }
    let applied = 0;
    const errors = [];
    grades.forEach(grade => {
      const q = quiz.questions.find(q => q.id === grade.id);
      if (!q) { errors.push(`Question ${grade.id} not found`); return; }
      q.grading.score = grade.score ?? q.grading.score;
      q.grading.max_score = grade.max_score || q.grading.max_score || q.marks || 1;
      q.grading.feedback = grade.feedback || null;
      q.grading.status = 'graded';
      q.grading.graded_by = grade.graded_by || 'llm';
      q.grading.criteria_used = grade.criteria_used || null;
      q.grading.graded_at = grade.graded_at || new Date().toISOString();
      applied++;
    });
    return { applied, errors };
  }

  function getScoreSummary(quiz) {
    const questions = quiz.questions;
    const graded = questions.filter(q => q.grading.status === 'graded');
    const totalScore = graded.reduce((sum, q) => sum + (q.grading.score || 0), 0);
    const maxScore = graded.reduce((sum, q) => sum + (q.grading.max_score || q.marks || 1), 0);

    const byTopic = {};
    graded.forEach(q => {
      const t = q.topic_name || 'General';
      if (!byTopic[t]) byTopic[t] = { score: 0, max: 0, count: 0 };
      byTopic[t].score += q.grading.score || 0;
      byTopic[t].max += q.grading.max_score || q.marks || 1;
      byTopic[t].count++;
    });

    return {
      totalScore, maxScore,
      percentage: maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0,
      gradedCount: graded.length,
      totalCount: questions.length,
      ungradedCount: questions.filter(q => q.grading.status === 'ungraded').length,
      needsRemarkCount: questions.filter(q => q.grading.status === 'needs_remark').length,
      autoGradedCount: graded.filter(q => q.grading.graded_by === 'auto').length,
      byTopic
    };
  }

  return { setManualGrade, applyGradingResponse, getScoreSummary };
})();
