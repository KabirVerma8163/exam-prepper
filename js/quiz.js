// Quiz state management module
const Quiz = (() => {
  let _data = null;
  let _currentIndex = 0;
  let _activeIndices = [];

  function load(json) {
    _data = typeof json === 'string' ? JSON.parse(json) : JSON.parse(JSON.stringify(json));
    _currentIndex = 0;
    _activeIndices = _data.questions.map((_, i) => i);
    if (_data.questions.length > 0) _data.questions[0].visited = true;
    return _data;
  }

  function getData() { return _data; }

  function save() {
    if (!_data) return null;
    return JSON.stringify(_data, null, 2);
  }

  function currentQuestion() {
    if (!_data || _activeIndices.length === 0) return null;
    return _data.questions[_activeIndices[_currentIndex]];
  }

  function goTo(index) {
    if (!_data || index < 0 || index >= _activeIndices.length) return false;
    _currentIndex = index;
    const q = _data.questions[_activeIndices[_currentIndex]];
    q.visited = true;
    return true;
  }

  function next() { return goTo(_currentIndex + 1); }
  function prev() { return goTo(_currentIndex - 1); }

  function setAnswer(questionId, answer) {
    if (!_data) return;
    const q = _data.questions.find(q => q.id === questionId);
    if (!q) return;
    q.user_answer = answer;

    if (q.type === 'mcq' || q.type === 'true_false') {
      const isCorrect = answer === q.correct_answer;
      q.grading.status = 'graded';
      q.grading.score = isCorrect ? (q.grading.max_score || q.marks || 1) : 0;
      q.grading.graded_by = 'auto';
      q.grading.graded_at = new Date().toISOString();
    }

    if (q.type === 'fill_blank' && q.blanks && Array.isArray(answer)) {
      const partialScore = q.blanks.reduce((acc, b, i) =>
        acc + ((answer[i] || '').trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0), 0
      );
      q.grading.status = 'graded';
      q.grading.score = partialScore;
      q.grading.max_score = q.blanks.length;
      q.grading.graded_by = 'auto';
      q.grading.graded_at = new Date().toISOString();
    }
  }

  function toggleFlag(questionId) {
    const q = _data?.questions.find(q => q.id === questionId);
    if (q) q.flagged = !q.flagged;
    return q?.flagged ?? false;
  }

  function filterByTopics(topicNames) {
    if (!_data) return;
    if (!topicNames || topicNames.length === 0) {
      _activeIndices = _data.questions.map((_, i) => i);
    } else {
      _activeIndices = _data.questions
        .map((q, i) => ({ q, i }))
        .filter(({ q }) => topicNames.includes(q.topic_name))
        .map(({ i }) => i);
    }
    _currentIndex = 0;
  }

  function getTopics() {
    if (!_data) return [];
    return [...new Set(_data.questions.map(q => q.topic_name).filter(Boolean))];
  }

  function getProgress() {
    if (!_data) return { total: 0, answered: 0, flagged: 0, current: 0 };
    const total = _activeIndices.length;
    const answered = _activeIndices.filter(i => _data.questions[i].user_answer !== null).length;
    const flagged = _activeIndices.filter(i => _data.questions[i].flagged).length;
    return { total, answered, flagged, current: _currentIndex };
  }

  function getQuestionAtIndex(index) {
    if (!_data || index < 0 || index >= _activeIndices.length) return null;
    return _data.questions[_activeIndices[index]];
  }

  function getActiveQuestions() {
    if (!_data) return [];
    return _activeIndices.map(i => _data.questions[i]);
  }

  function isLoaded() { return _data !== null; }

  return {
    load, getData, save, currentQuestion, goTo, next, prev,
    setAnswer, toggleFlag, filterByTopics, getTopics, getProgress,
    getQuestionAtIndex, getActiveQuestions, isLoaded,
    get currentIndex() { return _currentIndex; },
    get totalActive() { return _activeIndices.length; }
  };
})();
