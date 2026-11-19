(function (root) {
  'use strict';
  const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
  function cells(row) {
    const result = {};
    for (const cell of row.querySelectorAll('.section_crsbin > span.section_row')) {
      const label = cell.querySelector('.table-headers-xsmall');
      if (!label) continue;
      const key = text(label).replace(/[^a-z]/gi, '').toLowerCase();
      const copy = cell.cloneNode(true);
      copy.querySelectorAll('.table-headers-xsmall').forEach(node => node.remove());
      const select = cell.querySelector('select');
      result[key] = select ? select.value : text(copy);
    }
    return result;
  }
  function identity(row) {
    return { section: row.id.replace(/^section_/, ''), course: row.closest('[id^="courseBin_"]')?.id.replace(/^courseBin_/, '').toUpperCase() };
  }
  function checkout(doc, path = '/Checkout', live = false) {
    const form = doc.getElementById('MainForm');
    const button = doc.getElementById('SubmitButton');
    return {
      path, term: text(doc.getElementById('activeTermTab')),
      headings: [...doc.querySelectorAll('.RegAdDrpTitl')].map(text),
      courses: [...doc.querySelectorAll('[id^="courseBin_"]')].map(node => node.id.replace(/^courseBin_/, '')),
      rows: [...doc.querySelectorAll('.section[id^="section_"]')].map(row => {
        const values = cells(row);
        return { ...identity(row), units: values.units, grade: values.gradeoption, seatText: values.registered };
      }),
      submit: !!button && button.form === form && !button.disabled && (!live || !!button.getClientRects().length),
      action: form?.getAttribute('action'), method: form?.method
    };
  }
  function bin(doc) {
    return {
      term: text(doc.getElementById('activeTermTab')),
      rows: [...doc.querySelectorAll('.section[id^="section_"]')].map(row => {
        const info = identity(row);
        const active = [...row.querySelectorAll('.actionbar')].filter(node => node.style.display === 'block');
        const match = active.length === 1 && active[0].id.match(/^sched([YN])_reg([YN])_(\d{5})$/);
        if (!match || match[3] !== info.section) throw new Error('USC returned an ambiguous section status for ' + info.section + '.');
        const values = cells(row);
        const grade = row.querySelector('select[name="GradeOptionCode"]');
        return { ...info, scheduled: match[1] === 'Y', registered: match[2] === 'Y', units: values.units, grade: grade ? grade.value : values.gradeoption || '' };
      })
    };
  }
  root.SeatDOM = { text, cells, checkout, bin };
  if (typeof module !== 'undefined') module.exports = root.SeatDOM;
})(globalThis);
