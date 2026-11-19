(function (root) {
  'use strict';
  const guard = root.SeatGuard || (typeof module !== 'undefined' && module.exports ? require('./guard.js') : null);
  if (!guard) throw new Error('Load SeatGuard before SeatCatalog.');
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '';
  const termCode = value => { const term = String(value ?? ''); guard.termLabel(term); return term; };
  const compareCode = (a, b) => a.code.localeCompare(b.code, 'en', { numeric: true });
  function normalizeCourses(response) {
    if (!response || !Array.isArray(response.courses)) throw new Error('USC course catalog is unavailable or has an unexpected format.');
    const term = termCode(response.termCode);
    const courses = new Map();
    for (const row of response.courses) {
      if (!row || String(row.termCode) !== term) throw new Error('USC catalog contains a course from an unexpected semester.');
      let code;
      try { code = guard.normalizeCourse(row.scheduledCourseCode?.courseHyphen); }
      catch { continue; } // Unsupported identities are never offered as selectable courses.
      const title = text(row.name);
      if (!courses.has(code) || !courses.get(code).title) courses.set(code, { code, title });
    }
    return [...courses.values()].sort(compareCode);
  }
  function search(courses, query, limit = 20) {
    if (!Array.isArray(courses)) throw new Error('Load the course catalog before searching.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be from 1 to 100.');
    const rawQuery = text(query).toUpperCase();
    const compactQuery = rawQuery.replace(/[^A-Z0-9]/g, '');
    const tokens = rawQuery.split(/[\s-]+/).filter(Boolean);
    const ranked = [];
    for (const course of courses) {
      const code = guard.normalizeCourse(course?.code);
      const title = text(course.title);
      const compactCode = code.replace('-', '');
      const haystack = (code + ' ' + title).toUpperCase();
      const codeMatch = !!compactQuery && compactCode.includes(compactQuery);
      if (tokens.length && !codeMatch && !tokens.every(token => haystack.includes(token))) continue;
      const rank = !compactQuery ? 3 : compactCode === compactQuery ? 0 : compactCode.startsWith(compactQuery) ? 1 : codeMatch ? 2 : 3;
      ranked.push({ course: { code, title }, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || compareCode(a.course, b.course));
    return { courses: ranked.slice(0, limit).map(item => item.course), total: ranked.length };
  }
  function unitsList(value) {
    if (!Array.isArray(value) || !value.length) throw new Error('A USC section has no explicit unit choices.');
    return [...new Set(value.map(item => {
      if ((typeof item !== 'string' && typeof item !== 'number') || text(item) === '' ||
          (typeof item === 'string' && !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(item.trim())))
        throw new Error('A USC section has an unsupported unit choice.');
      const number = Number(item);
      if (!Number.isFinite(number) || number < 0 || number > 20) throw new Error('A USC section has an unsupported unit choice.');
      return String(number);
    }))].sort((a, b) => Number(a) - Number(b));
  }
  function meetingDetails(schedule) {
    if (schedule == null || (Array.isArray(schedule) && !schedule.length)) return { days: 'TBA', time: 'TBA', location: 'TBA' };
    if (!Array.isArray(schedule)) throw new Error('USC meeting details have an unexpected format.');
    const meetings = schedule.map(meeting => {
      if (!meeting || typeof meeting !== 'object') throw new Error('USC meeting details have an unexpected format.');
      const days = text(meeting.dayCode) || (Array.isArray(meeting.days) ? meeting.days.map(text).filter(Boolean).join('/') : '') || 'TBA';
      const start = text(meeting.startTime);
      const end = text(meeting.endTime);
      const time = start && end ? start + '-' + end : 'TBA';
      const location = text(meeting.location) || text(meeting.buildingRoom) || [text(meeting.building), text(meeting.room)].filter(Boolean).join(' ') || 'TBA';
      return { days, time, location };
    });
    return Object.fromEntries(['days', 'time', 'location'].map(key => [key, meetings.map(meeting => meeting[key]).join('; ')]));
  }
  function normalizeSections(response, inputTerm, inputCourse) {
    const term = termCode(inputTerm);
    const code = guard.normalizeCourse(inputCourse);
    if (!response || String(response.termCode) !== term || guard.normalizeCourse(response.scheduledCourseCode?.courseHyphen) !== code)
      throw new Error('USC returned an unexpected course or semester.');
    if (!Array.isArray(response.sections)) throw new Error('USC did not provide sections for this course.');
    const seen = new Set();
    const sections = response.sections.map(section => {
      if (!section || String(section.termCode) !== term ||
          (section.session?.termCode != null && String(section.session.termCode) !== term) ||
          (section.term?.value != null && String(section.term.value) !== term) ||
          (response.courseId != null && section.courseId != null && section.courseId !== response.courseId))
        throw new Error('USC section data belongs to an unexpected course or semester.');
      const id = text(section.sisSectionId);
      if (!/^[0-9]{5}$/.test(id) || seen.has(id)) throw new Error('USC section identity is missing or duplicated.');
      seen.add(id);
      if (!Number.isInteger(section.totalSeats) || section.totalSeats < 0 || !Number.isInteger(section.registeredSeats) || section.registeredSeats < 0 ||
          typeof section.isFull !== 'boolean' || typeof section.isCancelled !== 'boolean')
        throw new Error('USC section seat availability is incomplete.');
      const units = unitsList(section.units);
      const instructors = Array.isArray(section.instructors) ? section.instructors.map(person => person && typeof person === 'object' ? [text(person.firstName), text(person.lastName)].filter(Boolean).join(' ') : '').filter(Boolean).join(', ') : '';
      const normalized = {
        id, type: text(section.rnrMode) || 'TBA', units,
        instructors: instructors || 'TBA', ...meetingDetails(section.schedule),
        registered: section.registeredSeats, total: section.totalSeats,
        open: section.totalSeats > 0 && !section.isFull && !section.isCancelled && section.registeredSeats < section.totalSeats,
        cancelled: section.isCancelled
      };
      if (units.length === 1) normalized.defaultUnits = units[0];
      // Expose USC's linkage hints as data only. A picker must not infer a required
      // lecture/discussion/lab bundle from matching codes or adjacent section IDs.
      for (const key of ['linkCode', 'linkCodeForSort', 'group']) {
        if (section[key] != null && text(section[key])) normalized[key] = text(section[key]);
      }
      if (section.session?.rnrSessionCode != null) normalized.session = text(section.session.rnrSessionCode);
      if (typeof section.hasDClearance === 'boolean') normalized.hasDClearance = section.hasDClearance;
      for (const key of ['notes', 'description']) if (text(section[key])) normalized[key] = text(section[key]);
      return normalized;
    });
    sections.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    return { code, title: text(response.name), term, sections };
  }
  root.SeatCatalog = { normalizeCourses, search, normalizeSections };
  if (typeof module !== 'undefined') module.exports = root.SeatCatalog;
})(globalThis);
