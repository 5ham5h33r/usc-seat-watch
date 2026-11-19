(function (root) {
  'use strict';
  const grades = Object.freeze({ L: 'Letter Grade', PN: 'Pass/No Pass', V: 'Audit' });
  const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function normalizeCourse(value) {
    if (typeof value !== 'string') throw new Error('Enter a course code such as MATH-225.');
    const match = value.trim().toUpperCase().match(/^([A-Z]{2,8})\s*-?\s*([0-9]{3,4}[A-Z]{0,4})$/);
    if (!match) throw new Error('Use a department code and course number, such as MATH-225.');
    return match[1] + '-' + match[2];
  }
  function normalizeTerm(value) {
    const term = String(value ?? '').trim();
    if (!/^[1-9][0-9]{3}[123]$/.test(term)) throw new Error('Select a valid USC semester.');
    return term;
  }
  function termLabel(value) {
    const term = normalizeTerm(value);
    return ({ 1: 'Spring', 2: 'Summer', 3: 'Fall' })[term[4]] + ' ' + term.slice(0, 4) + ' Classes';
  }
  function sectionId(value) {
    const id = String(value ?? '').trim();
    if (!/^[0-9]{5}$/.test(id)) throw new Error('Section IDs must contain five digits.');
    return id;
  }
  function unitsValue(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || text(value) === '' ||
        (typeof value === 'string' && !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value.trim())))
      throw new Error('Each section needs an explicit numeric unit value.');
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 20) throw new Error('Section units must be between 0 and 20.');
    return String(number);
  }
  function normalizeTarget(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A watch target is invalid.');
    const course = normalizeCourse(input.course);
    const grade = input.grade === undefined ? 'L' : text(input.grade).toUpperCase();
    if (!Object.hasOwn(grades, grade)) throw new Error('Grade option must be L, PN, or V.');
    if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 6)
      throw new Error('Each target needs one to six section components.');
    const seen = new Set();
    const sections = input.sections.map(section => {
      if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error('A section component is invalid.');
      const id = sectionId(section.id);
      if (seen.has(id)) throw new Error('A section cannot appear twice in a target.');
      seen.add(id);
      return { id, units: unitsValue(section.units) };
    });
    return { id: course + ':' + sections.map(s => s.id).join(','), course, sections, grade };
  }
  function normalizeConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Watchlist configuration is invalid.');
    const term = normalizeTerm(input.term);
    if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 12)
      throw new Error('Watch one to twelve course targets.');
    const allSections = new Set();
    const targets = input.targets.map(normalizeTarget);
    for (const target of targets) for (const section of target.sections) {
      if (allSections.has(section.id)) throw new Error('A section can belong to only one watch target.');
      allSections.add(section.id);
    }
    return { term, targets };
  }
  function availability(data, inputTarget, inputTerm) {
    const target = normalizeTarget(inputTarget);
    const term = normalizeTerm(inputTerm);
    if (String(data?.termCode) !== term || normalizeCourse(data?.scheduledCourseCode?.courseHyphen) !== target.course)
      throw new Error('USC returned an unexpected course or term.');
    if (!Array.isArray(data.sections)) throw new Error('USC section data is missing.');
    const sections = target.sections.map(requested => {
      const matches = data.sections.filter(section => String(section.sisSectionId) === requested.id);
      if (matches.length !== 1) throw new Error('A requested section was not uniquely identified.');
      const section = matches[0];
      if (String(section.termCode) !== term || typeof section.isCancelled !== 'boolean' || typeof section.isFull !== 'boolean' ||
          !Number.isInteger(section.totalSeats) || !Number.isInteger(section.registeredSeats) || section.totalSeats <= 0 || section.registeredSeats < 0)
        throw new Error('USC seat data was incomplete or unsupported.');
      return { id: requested.id, registered: section.registeredSeats, total: section.totalSeats,
        open: !section.isCancelled && !section.isFull && section.registeredSeats < section.totalSeats };
    });
    return { id: target.id, course: target.course, term, open: sections.every(section => section.open), sections };
  }
  function gradeMatches(value, targetGrade, units) {
    const grade = text(value);
    if (Number(units) === 0 && ['', 'N/A'].includes(grade.toUpperCase())) return true;
    return grade === targetGrade || grade === grades[targetGrade];
  }
  function rowMatches(row, requested, target) {
    if (normalizeCourse(row.course) !== target.course) throw new Error('A target section belongs to a different course.');
    if (unitsValue(row.units) !== requested.units || !gradeMatches(row.grade, target.grade, requested.units))
      throw new Error('Target section units or grade option changed.');
  }
  function validateCheckout(snapshot, inputTarget, inputTerm, requireOpen = false) {
    try {
      const target = normalizeTarget(inputTarget);
      if (!snapshot || snapshot.path !== '/Checkout') return 'Open the signed-in USC Checkout page.';
      if (snapshot.term !== termLabel(inputTerm)) return 'Checkout is for the wrong semester.';
      if (!Array.isArray(snapshot.headings) || snapshot.headings.length !== 1 ||
          text(snapshot.headings[0]) !== 'You are about to REGISTER for the following sections:')
        return 'Checkout must contain only registration, with no drops or other changes.';
      if (!Array.isArray(snapshot.courses) || snapshot.courses.length !== 1 || normalizeCourse(snapshot.courses[0]) !== target.course)
        return 'Checkout must contain only the selected target course.';
      if (!Array.isArray(snapshot.rows) || snapshot.rows.length !== target.sections.length) return 'Checkout contains unexpected or missing sections.';
      const rows = new Map();
      for (const row of snapshot.rows) {
        const id = sectionId(row?.section);
        if (rows.has(id)) return 'Checkout contains duplicate sections.';
        rows.set(id, row);
      }
      if (snapshot.submit !== true || snapshot.action !== '/CheckoutResponse' || snapshot.method !== 'post')
        return 'The expected USC Submit form is unavailable.';
      for (const requested of target.sections) {
        const row = rows.get(requested.id);
        if (!row) return 'Checkout contains unexpected or missing sections.';
        rowMatches(row, requested, target);
        if (requireOpen) {
          const seatText = text(row.seatText);
          const counts = seatText.match(/^([0-9]+)\s*(?:of|\/)\s*([0-9]+)$/i);
          if (seatText !== 'Open' && !(counts && Number(counts[2]) > 0 && Number(counts[1]) < Number(counts[2])))
            return seatText === 'Closed' ? 'closed' : 'Checkout availability format is unrecognized; review manually.';
        }
      }
      return null;
    } catch (error) { return error.message; }
  }
  function assertBin(bin, term) {
    if (!bin || bin.term !== termLabel(term)) throw new Error('Course Bin is for the wrong semester.');
    if (!Array.isArray(bin.rows)) throw new Error('Course Bin section data is unavailable.');
    const seen = new Set();
    for (const row of bin.rows) {
      if (!row || typeof row !== 'object') throw new Error('Course Bin contains an invalid row.');
      const id = sectionId(row.section);
      normalizeCourse(row.course);
      if (seen.has(id)) throw new Error('Course Bin contains duplicate section identities.');
      seen.add(id);
      if (typeof row.scheduled !== 'boolean' || typeof row.registered !== 'boolean')
        throw new Error('Course Bin scheduling or registration status is ambiguous.');
      if (row.registered && !row.scheduled) throw new Error('Course Bin contains a pending drop. Resolve it manually before continuing.');
    }
    return bin;
  }
  function isolationPlan(bin, inputTarget, term) {
    assertBin(bin, term);
    const target = normalizeTarget(inputTarget);
    const byId = new Map(bin.rows.map(row => [sectionId(row.section), row]));
    const targetIds = new Set(target.sections.map(section => section.id));
    const present = target.sections.map(section => byId.get(section.id)).filter(Boolean);
    for (const requested of target.sections) {
      const row = byId.get(requested.id);
      if (row && normalizeCourse(row.course) !== target.course) throw new Error('A target section belongs to a different course.');
    }
    const registeredCount = present.filter(row => row.registered).length;
    if (registeredCount && registeredCount !== target.sections.length)
      throw new Error('Only part of the target is registered. Review the linked sections manually.');
    if (registeredCount === target.sections.length) return { unschedule: [], schedule: [], missing: [], registered: true };
    // Existing enrollment is terminal and never changed. Only pending target
    // registrations need configurable option checks; registered rows may show
    // only a "Change option" control rather than their current grade value.
    for (const requested of target.sections) {
      const row = byId.get(requested.id);
      if (row) rowMatches(row, requested, target);
    }
    return {
      unschedule: bin.rows.filter(row => row.scheduled && !row.registered && !targetIds.has(sectionId(row.section))).map(row => sectionId(row.section)),
      schedule: target.sections.filter(section => byId.has(section.id) && !byId.get(section.id).scheduled).map(section => section.id),
      missing: target.sections.filter(section => !byId.has(section.id)).map(section => section.id),
      registered: false
    };
  }
  function restorePlan(bin, journal, term) {
    assertBin(bin, term);
    if (!journal || !Array.isArray(journal.removed) || !Array.isArray(journal.added)) throw new Error('Isolation recovery journal is invalid.');
    const byId = new Map(bin.rows.map(row => [sectionId(row.section), row]));
    const seen = new Set();
    const plan = { schedule: [], unschedule: [] };
    for (const [entries, operation, shouldBeScheduled] of [[journal.removed, 'schedule', false], [journal.added, 'unschedule', true]]) {
      for (const entry of entries) {
        const id = sectionId(entry?.section);
        const course = normalizeCourse(entry?.course);
        if (seen.has(id)) throw new Error('Isolation recovery journal contains duplicate section identities.');
        seen.add(id);
        const row = byId.get(id);
        // A journal is persisted before adding a missing target. If the click never
        // happened, an absent newly added row has nothing to restore.
        if (!row && operation === 'unschedule' && entry.wasMissing === true) continue;
        if (!row || normalizeCourse(row.course) !== course) throw new Error('An isolated section is missing or its course identity changed. Review Course Bin manually.');
        if (!row.registered && row.scheduled === shouldBeScheduled) plan[operation].push(id);
      }
    }
    return plan;
  }
  function retryAfterMs(value, now = Date.now()) {
    if (value == null || !String(value).trim()) return 0;
    const textValue = String(value).trim();
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(textValue)) {
      const milliseconds = Number(textValue) * 1000;
      return Number.isFinite(milliseconds) ? milliseconds : 0;
    }
    const date = Date.parse(textValue);
    return Number.isFinite(date) ? Math.max(0, date - now) : 0;
  }
  root.SeatGuard = { normalizeCourse, termLabel, normalizeConfig, availability, validateCheckout, assertBin, isolationPlan, restorePlan, retryAfterMs };
  if (typeof module !== 'undefined') module.exports = root.SeatGuard;
})(globalThis);
