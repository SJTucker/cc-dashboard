// Pixel art for the record animation, as character grids. Each character is a key
// in PALETTE and '.' is a transparent pixel. This file holds data only. All three
// characters (an ice ninja, a soldier and the orange Claude character) are original
// drawings made for this dashboard.

export const PALETTE = { K: '#0b0b14', B: '#3fa9ff', D: '#1d5bb8', W: '#ffffff', S: '#e8b48a', O: '#d97757', I: '#c8f6ff', i: '#5fc8f0', Y: '#ffe14f',
  R: '#59606a', r: '#848c96', h: '#9a8a62', g: '#5a4f38', G: '#7a7256', V: '#4a4a3c', E: '#20262c', k: '#3a3d42', M: '#c4ccd4' };
const blank = '................';
const HEAD = ['.....KKKKKK.....', '....KDDDDDDK....', '....DBBBBBBD....', '....DKWKKWKD....', '....DBBBBBBD....', '.....DBBBBD.....'];
const LEGS_STAND = ['.....DBBBBD.....', '.....DB..BD.....', '.....DB..BD.....', '.....DB..BD.....', '.....KK..KK.....', '....KKK..KKK....'];
const LEGS_WALK = ['.....DBBBBD.....', '....DB....BD....', '...DB......BD...', '...DB......BD...', '...KK......KK...', '..KKK......KKK..'];
const LEGS_KICK = ['.....DBBBBBBBBKK', '.....DB.....BKKK', '.....DB.........', '.....DB.........', '.....KK.........', '....KKK.........'];
const ARMS = ['...DDDBBBBDDD...', '..DBBBBBBBBBBD..', '..DB.DBBBBD.BD..', '..SB.DBBBBD.BS..', '..S..DKKKKD..S..'];
const ARMS_THROW = ['...DDDBBBBDDDDDD', '..DBBBBBBBBBBBSS', '..DB.DBBBBD..BSS', '..SB.DBBBBD.....', '..S..DKKKKD.....'];
export const NINJA = {
  stand: [blank, blank, blank, ...HEAD, ...ARMS, ...LEGS_STAND],
  walk: [blank, blank, blank, ...HEAD, ...ARMS, ...LEGS_WALK],
  throw: [blank, blank, blank, ...HEAD, ...ARMS_THROW, ...LEGS_STAND],
  kick: [blank, blank, blank, ...HEAD, ...ARMS, ...LEGS_KICK],
  win: ['.............SS.', '.............BB.', '.............BB.',
        '.....KKKKKK..BB.', '....KDDDDDDK.BB.', '....DBBBBBBD.BB.', '....DKWKKWKD.BB.', '....DBBBBBBD.BD.', '.....DBBBBD.DD..',
        '...DDDBBBBDDD...', '..DBBBBBBBBBB...', '..DB.DBBBBD.....', '..SB.DBBBBD.....', '..S..DKKKKD.....', ...LEGS_STAND],
};
// Soldier, 24 wide: combat helmet with an NVG mount, eye pro, plate carrier, AR-style rifle.
const S_TOP = [
  '......hhhhhh............',
  '.....hhhhhhhh...........',
  '....hhhhhhhhhh..........',
  '....hhhhhhhhhhKK........',
  '....gggggggggg..........',
  '.....SSSEEEE............',
  '.....SSSSSSS............',
  '......SKSSS.............'];
const S_AIM = [
  '....VVVVVVVV............',
  '...GVVVVVVVVGG..........',
  '...GVVVVVVVVGGGGGG......',
  '...GVVVVVVV.............',
  '...GVVVVVVV.............',
  '....KKKKKKK.............'];
const S_LOW = S_AIM;
// AR-style rifle drawn over the body: optic, stock, pistol grip, curved magazine, railed handguard, barrel.
export const RIFLE = [
  '........rrrr..........',
  '........RRRR......R...',
  'RRRRRRRRRRRRRrrrrrrMMM',
  'RR...RSRRRRRRrrSrrr...',
  'R.....RR.RRR..........',
  '.......R..RRR.........',
  '...........RR.........'];
const S_LEGS = ['....GGGGGGG.............', '....GGG..GGG............', '....GGG..GGG............', '....kGG..kGG............', '....KKK..KKK............', '...KKKK..KKKK...........'];
const S_WALK = ['....GGGGGGG.............', '...GGG....GGG...........', '..GGG......GGG..........', '..kGG......kGG..........', '..KKK......KKK..........', '.KKKK......KKKK.........'];
export const SOLDIER = { aim: [...S_TOP, ...S_AIM, ...S_LEGS], walk: [...S_TOP, ...S_AIM, ...S_WALK], low: [...S_TOP, ...S_LOW, ...S_LEGS] };
export const CLAUDE = ['..OOOOOOOOOO..', '..OOOOOOOOOO..', '..OOKKOOKKOO..', '..OOKKOOKKOO..', 'OOOOOOOOOOOOOO',
  'OOOOOOOOOOOOOO', '..OOOOOOOOOO..', '..OOOOOOOOOO..', '..O.O....O.O..', '..O.O....O.O..'];
export const BLOOD = ['#e01b24', '#b0101c', '#8a0a14', '#ff3a3a', '#6e0810'];

// Colour swaps applied to the Claude character: encased in ice, and a white hit flash.
export const FROZEN = { O: 'I', K: 'i' };
export const WHITE = { O: 'W', K: 'W' };
