const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

export function teacherSurnames(value) {
  return [...new Set(String(value || '').split(/[,;\/\n]+/u).map(part => {
    const name = part.trim()
      .replace(/^(?:(?:профессор|проф|доцент|доц|(?:старший|ст\.?)\s*(?:преподаватель|преп|пр)|преподаватель|преп|ассистент|ассист)\.?\s+)+/iu, '')
      .replace(/^(?:[А-ЯЁA-Z]\.\s*){1,2}/iu, '')
      .match(/^[А-ЯЁA-Z]+(?:-[А-ЯЁA-Z]+)*/iu)?.[0];
    return normalize(name);
  }).filter(Boolean))].sort();
}

// Neither group, subgroup, lesson type nor display mode changes this identity.
// Preserve the subject text: do not collapse different PE titles, for example.
export function subjectTeacherColorKey(title, professor) {
  const subject = normalize(title);
  const surnames = teacherSurnames(professor);
  return subject && surnames.length ? JSON.stringify(['lesson-v3', subject, surnames]) : null;
}
