// Record schemas. The field ORDER is the wire format for QR transfer — only ever append new fields.
// Type: 'i' = integer, 's' = string.

export const MATCH_FIELDS = [
  ['id', 's', 'Record ID'],
  ['ev', 's', 'Event'],
  ['mt', 'i', 'Match'],
  ['tm', 'i', 'Team'],
  ['al', 's', 'Alliance'],          // R | B
  ['sc', 's', 'Scout'],
  ['ts', 'i', 'Saved (unix)'],
  ['ns', 'i', 'No show'],
  // AUTO
  ['st', 's', 'Start tile'],         // absolute tile as viewed from audience, e.g. "B1"
  ['lv', 'i', 'AUTO leave'],
  ['aM', 'i', 'AUTO HIVE made'],
  ['aX', 'i', 'AUTO HIVE missed'],
  ['aP', 'i', 'AUTO park'],
  ['aS', 's', 'AUTO sources'],       // flags: P preload, F flower, G garden, L floor
  // TELEOP
  ['tM', 'i', 'TELEOP HIVE made'],
  ['tX', 'i', 'TELEOP HIVE missed'],
  ['iS', 's', 'Intake sources'],     // flags: L floor, F flower bottom, G garden, Z loading zone
  // ENDGAME
  ['fN', 'i', 'NECTAR into FLOWER'],
  ['fP', 'i', 'POLLEN into FLOWER'],
  ['gd', 'i', 'Into GARDEN'],
  ['pk', 'i', 'Park'],
  // OVERALL
  ['df', 'i', 'Defense (0-2)'],
  ['dr', 'i', 'Driver (1-7)'],
  ['br', 's', 'Issues'],             // flags: D dead/disconnect, B broke, T tipped over
  ['mn', 'i', 'Minor fouls'],
  ['mj', 'i', 'Major fouls'],
  ['cd', 'i', 'Card (0 none,1 yellow,2 red)'],
  ['nt', 's', 'Notes'],
];

export const PIT_FIELDS = [
  ['id', 's', 'Record ID'],
  ['ev', 's', 'Event'],
  ['tm', 'i', 'Team'],
  ['sc', 's', 'Scout'],
  ['ts', 'i', 'Saved (unix)'],
  ['dt', 's', 'Drivetrain'],         // M mecanum, T tank, S swerve, O other
  ['ln', 's', 'Launcher'],           // W flywheel, C catapult, O other, N none
  ['hv', 'i', 'Launches into HIVE'],
  ['fl', 'i', 'Places in FLOWER'],
  ['fb', 'i', 'Pulls POLLEN from FLOWER'],
  ['nc', 'i', 'Handles NECTAR'],
  ['cap', 'i', 'Max carried'],
  ['cy', 'i', 'Claimed TELEOP launches'],
  ['ast', 's', 'AUTO start tiles'],  // red-side frame (A-C), comma list
  ['aL', 'i', 'Claimed AUTO launches'],
  ['aLv', 'i', 'AUTO leave'],
  ['aPk', 'i', 'AUTO park'],
  ['aS', 's', 'AUTO sources'],
  ['rl', 's', 'Preferred role'],     // H hive, F flower/endgame, D defense, X flexible
  ['vs', 'i', 'Uses AprilTags'],
  ['nt', 's', 'Notes'],
];

export const LABELS = {
  aS: { P: 'Preload only', F: 'FLOWER', G: 'GARDEN', L: 'Floor' },
  iS: { L: 'Floor', F: 'FLOWER bottom', G: 'GARDEN', Z: 'LOADING ZONE' },
  br: { D: 'Dead / disconnected', B: 'Broke / lost part', T: 'Tipped over' },
  dt: { M: 'Mecanum', T: 'Tank', S: 'Swerve', O: 'Other' },
  ln: { W: 'Flywheel', C: 'Catapult', O: 'Other', N: 'None' },
  rl: { H: 'HIVE launcher', F: 'FLOWER / endgame', D: 'Defense', X: 'Flexible' },
  df: ['None', 'Some', 'Heavy'],
  cd: ['None', 'Yellow', 'Red'],
};

export function blankMatch() {
  const r = { t: 'm' };
  for (const [k, ty] of MATCH_FIELDS) r[k] = ty === 'i' ? 0 : '';
  return r;
}

export function blankPit() {
  const r = { t: 'p' };
  for (const [k, ty] of PIT_FIELDS) r[k] = ty === 'i' ? 0 : '';
  r.cap = 0;
  return r;
}

function fieldsFor(type) { return type === 'p' ? PIT_FIELDS : MATCH_FIELDS; }

// Compact array form, trailing empty values trimmed.
export function toArr(rec) {
  const arr = fieldsFor(rec.t).map(([k, ty]) => (ty === 'i' ? Math.round(Number(rec[k]) || 0) : String(rec[k] ?? '')));
  while (arr.length && (arr[arr.length - 1] === 0 || arr[arr.length - 1] === '')) arr.pop();
  return arr;
}

export function fromArr(arr, type) {
  const r = { t: type };
  fieldsFor(type).forEach(([k, ty], i) => {
    const v = arr[i];
    r[k] = ty === 'i' ? (Number(v) || 0) : (v == null ? '' : String(v));
  });
  return r;
}

export function validRecord(r) {
  return r && (r.t === 'm' || r.t === 'p') && typeof r.id === 'string' && r.id.length > 2 && r.tm > 0;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV(records, type) {
  const fields = fieldsFor(type);
  const head = fields.map(f => csvCell(f[2])).join(',');
  const rows = records.map(r => fields.map(([k]) => csvCell(r[k])).join(','));
  return [head, ...rows].join('\r\n');
}
