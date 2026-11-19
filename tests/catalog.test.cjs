const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizeCourses, search, normalizeSections } = require('../extension/catalog.js');
const catalogRow = (code, title, extra = {}) => ({ scheduledCourseCode: { courseHyphen: code }, name: title, termCode: 20271, sections: null, courseUnits: null, ...extra });
const catalog = () => ({ termCode: 20271, courseCount: 4, searchQuery: null, programs: null, courses: [catalogRow('PHED-155A', 'Golf'), catalogRow('PHED-120A', 'Yoga'), catalogRow('MATH-225', 'Linear Algebra and Linear Differential Equations'), catalogRow('CSCI-587', 'Geospatial Data Analysis')] });
const section = (extra = {}) => ({ sisSectionId: '50380', courseId: 61059, termCode: 20271, rnrMode: 'Lecture', units: ['4.0'], instructors: [{ firstName: 'Bo', lastName: 'Shrewsbury' }], schedule: [{ dayCode: 'MWF', days: ['Mon', 'Wed', 'Fri'], startTime: '08:30', endTime: '09:50', sectionLocationSqNumber: 1 }], registeredSeats: 16, totalSeats: 157, isFull: false, isCancelled: false, session: { termCode: '20271', rnrSessionCode: '001' }, term: { value: 20271 }, linkCode: null, linkCodeForSort: null, group: null, hasDClearance: false, ...extra });
const response = (sections = [section()]) => ({ termCode: 20271, courseId: 61059, scheduledCourseCode: { courseHyphen: 'PHYS-151' }, name: 'Fundamentals of Physics I: Mechanics, Oscillations and Waves', sections });

test('normalizes the official Autocomplete response object, across departments', () => {
  assert.deepEqual(normalizeCourses(catalog()), [
    { code: 'CSCI-587', title: 'Geospatial Data Analysis' }, { code: 'MATH-225', title: 'Linear Algebra and Linear Differential Equations' },
    { code: 'PHED-120A', title: 'Yoga' }, { code: 'PHED-155A', title: 'Golf' }
  ]);
  assert.deepEqual(normalizeCourses({ termCode: '20271', courses: [] }), []);
});
test('deduplicates canonical identities and does not offer unsupported or missing course codes', () => {
  const data = catalog();
  data.courses.push(catalogRow('csci 587', 'Geospatial Data Analysis'), catalogRow(null, 'Unknown'), catalogRow('BAD-CODE', 'Unknown'), catalogRow('PHED-120A', 'Yoga'));
  const courses = normalizeCourses(data);
  assert.equal(courses.length, 4); assert.equal(courses.filter(course => course.code === 'CSCI-587').length, 1);
});
test('fails closed on wrong catalog shape or mixed semesters', () => {
  for (const data of [null, [], { courses: [] }, { termCode: 20274, courses: [] }, { termCode: 20271, courses: {} }, { termCode: 20271, courses: [catalogRow('CSCI-587', 'Wrong semester', { termCode: 20273 })] }])
    assert.throws(() => normalizeCourses(data));
});
test('search matches department, compact course codes, spaced codes and title words', () => {
  const courses = normalizeCourses(catalog());
  for (const query of ['csci', 'CSCI 587', 'csci587', 'CSCI-587', 'geospatial', 'data analysis']) assert.equal(search(courses, query).courses[0].code, 'CSCI-587');
  assert.equal(search(courses, 'PHED').total, 2);
  assert.equal(search(courses, 'Algebra Linear').courses[0].code, 'MATH-225');
  assert.deepEqual(search(courses, 'not a course'), { courses: [], total: 0 });
});
test('search reports total before limiting and ranks exact course code first', () => {
  const courses = normalizeCourses(catalog());
  assert.equal(search(courses, '', 2).courses.length, 2); assert.equal(search(courses, '', 2).total, 4);
  assert.equal(search([{ code: 'PHYS-115', title: 'PHYS 151 overview' }, { code: 'PHYS-151', title: 'Mechanics' }], 'PHYS151').courses[0].code, 'PHYS-151');
  for (const limit of [0, -1, 101, 1.5, '20']) assert.throws(() => search(courses, '', limit));
});
test('normalizes the observed PHYS151 lecture shape without inventing missing location', () => {
  const data = normalizeSections(response(), '20271', 'phys 151');
  assert.equal(data.code, 'PHYS-151'); assert.equal(data.term, '20271');
  assert.deepEqual(data.sections[0], { id: '50380', type: 'Lecture', units: ['4'], instructors: 'Bo Shrewsbury', days: 'MWF', time: '08:30-09:50', location: 'TBA', registered: 16, total: 157, open: true, cancelled: false, defaultUnits: '4', session: '001', hasDClearance: false });
});
test('preserves zero-unit labs, group hints and descriptive linkage instructions without picking a bundle', () => {
  const data = normalizeSections(response([
    section({ sisSectionId: '50386', rnrMode: 'Lab', units: ['0.0'], linkCodeForSort: 'Z', instructors: [], notes: 'Choose a lab.', description: 'Register for lec, 1 lab & quiz.' }),
    section({ sisSectionId: '50383', rnrMode: 'Discussion', units: ['0.0'], linkCode: 'A', group: 'Group 1' })
  ]), '20271', 'PHYS-151');
  assert.deepEqual(data.sections.map(row => row.id), ['50383', '50386']);
  assert.deepEqual(data.sections[1].units, ['0']); assert.equal(data.sections[1].defaultUnits, '0');
  assert.equal(data.sections[1].linkCodeForSort, 'Z'); assert.equal(data.sections[1].instructors, 'TBA');
  assert.equal(data.sections[0].linkCode, 'A'); assert.equal(data.sections[0].group, 'Group 1');
  assert.equal(data.sections[1].description, 'Register for lec, 1 lab & quiz.');
  assert.ok(!Object.hasOwn(data, 'selectedSections'));
});
test('variable units require a user choice rather than inferring a maximum or course-wide value', () => {
  const data = normalizeSections(response([section({ units: ['4.0', '2', '4', '3.00'] })]), '20271', 'PHYS151');
  assert.deepEqual(data.sections[0].units, ['2', '3', '4']); assert.ok(!Object.hasOwn(data.sections[0], 'defaultUnits'));
  for (const units of [null, [], [''], ['0x10'], [true], [null], ['21'], ['-1'], [Infinity]]) assert.throws(() => normalizeSections(response([section({ units })]), '20271', 'PHYS151'));
});
test('sections fail closed on course, semester, missing or duplicate section identities', () => {
  for (const edit of [data => data.termCode = 20273, data => data.scheduledCourseCode.courseHyphen = 'PHYS-152', data => data.sections = null, data => data.sections[0].termCode = 20273, data => data.sections[0].session.termCode = '20273', data => data.sections[0].term.value = 20273, data => data.sections[0].courseId = 99999, data => data.sections[0].sisSectionId = '50380R', data => data.sections.push({ ...data.sections[0] })]) {
    const data = response(); edit(data); assert.throws(() => normalizeSections(data, '20271', 'PHYS-151'));
  }
});
test('seat status closes full, cancelled, over-enrolled and zero-capacity sections', () => {
  for (const extra of [{ isFull: true }, { isCancelled: true }, { registeredSeats: 200 }, { registeredSeats: 0, totalSeats: 0 }]) assert.equal(normalizeSections(response([section(extra)]), '20271', 'PHYS151').sections[0].open, false);
  for (const extra of [{ totalSeats: '157' }, { registeredSeats: -1 }, { isFull: undefined }, { isCancelled: null }]) assert.throws(() => normalizeSections(response([section(extra)]), '20271', 'PHYS151'));
});
test('meeting details preserve multiple meetings and use supplied location fields only', () => {
  const data = normalizeSections(response([section({ instructors: [{ firstName: ' Bo ', lastName: 'Shrewsbury' }, { firstName: 'Jane', lastName: 'Doe' }], schedule: [
    { dayCode: 'MW', startTime: '08:30', endTime: '09:50', location: 'SLH 100' },
    { days: ['Fri'], startTime: '10:00', endTime: '10:50', buildingRoom: 'ZHS 352' },
    { dayCode: 'T', startTime: '12:00', endTime: '12:50', building: 'SGM', room: '101' }
  ] })]), '20271', 'PHYS151').sections[0];
  assert.equal(data.instructors, 'Bo Shrewsbury, Jane Doe'); assert.equal(data.days, 'MW; Fri; T');
  assert.equal(data.time, '08:30-09:50; 10:00-10:50; 12:00-12:50'); assert.equal(data.location, 'SLH 100; ZHS 352; SGM 101');
  const tba = normalizeSections(response([section({ schedule: null })]), '20271', 'PHYS151').sections[0];
  assert.equal(tba.days, 'TBA'); assert.equal(tba.time, 'TBA'); assert.equal(tba.location, 'TBA');
});
test('classic script global works with SeatGuard and no CommonJS', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('extension/guard.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/catalog.js', 'utf8'), context);
  assert.equal(context.SeatCatalog.search([{ code: 'BUAD-304', title: 'Organizational Behavior' }], 'organizational').courses[0].code, 'BUAD-304');
});
