/**
 * Commuter stories (v2): a rider's generated name, pure and seeded. A first name and a surname
 * initial ("Amara O."), drawn from pools of common given names grouped roughly by each city's
 * population (the shares follow the 2020 US and 2021 UK censuses, loosely). Only common first
 * names, no surnames: nobody real is named. The same identity always gets the same name.
 */
import type { CityId } from '../balance';
import { hash32x4 } from '../core/rng';

interface Pool {
  /** Share of the city's commuters. */
  w: number;
  names: readonly string[];
  /** Surname initials, as common in the group. */
  initials: string;
}

const NYC: readonly Pool[] = [
  {
    w: 0.28,
    names: ['Ana', 'Luis', 'María', 'José', 'Carmen', 'Javier', 'Yesenia', 'Wilfredo', 'Daniela', 'Miguel', 'Rosa', 'Andrés', 'Lucía', 'Héctor', 'Marisol', 'Jorge', 'Yamilet', 'Rafael', 'Sofía', 'Esteban', 'Gabriela', 'Ramón', 'Valentina', 'Joel', 'Belkis', 'Nelson', 'Xiomara', 'Fausto'],
    initials: 'RRGGMMPPDSSCLVFHTA',
  },
  {
    w: 0.31,
    names: ['Michael', 'Sarah', 'Anthony', 'Rachel', 'Kevin', 'Maureen', 'Daniel', 'Rebecca', 'Joseph', 'Theresa', 'Eli', 'Miriam', 'Dmitri', 'Irina', 'Nikos', 'Eleni', 'Sean', 'Bridget', 'Paul', 'Laura', 'Adam', 'Natalie', 'Frank', 'Gina', 'Avi', 'Tova', 'Olek', 'Katie'],
    initials: 'KKMMSSBBRCFLWGDPNO',
  },
  {
    w: 0.2,
    names: ['Jasmine', 'Marcus', 'Keisha', 'Andre', 'Tanisha', 'Darnell', 'Imani', 'Jerome', 'Aaliyah', 'Terrence', 'Shanice', 'Malik', 'Nadège', 'Kemar', 'Shantel', 'Wesley', 'Simone', 'Kwame', 'Ama', 'Chidi', 'Adaeze', 'Dwayne', 'Monique', 'Fabienne', 'Rohan', 'Tiana', 'Jamal', 'Yvette'],
    initials: 'JJWWBBHTDRMCAPSLGE',
  },
  {
    w: 0.15,
    names: ['Wei', 'Mei', 'Jian', 'Lan', 'Hui', 'Xin', 'Priya', 'Arjun', 'Sunita', 'Vikram', 'Ji-woo', 'Min-jun', 'Soo-ah', 'Tanvir', 'Nusrat', 'Farhan', 'Rhea', 'Marites', 'Jericho', 'Anh', 'Duc', 'Kenji', 'Yuki', 'Ritu', 'Sabbir', 'Haruka', 'Chen', 'Divya'],
    initials: 'CCLLWWZKPSRHNTYJAM',
  },
  {
    w: 0.06,
    names: ['Omar', 'Layla', 'Yusuf', 'Amira', 'Karim', 'Nour', 'Mamadou', 'Fatoumata', 'Ibrahim', 'Aisha', 'Tariq', 'Samira', 'Ousmane', 'Mariam', 'Hassan', 'Rania'],
    initials: 'AAKKSDBHMTYN',
  },
];

const LONDON: readonly Pool[] = [
  {
    w: 0.37,
    names: ['Oliver', 'Emily', 'Jack', 'Charlotte', 'Harry', 'Sophie', 'James', 'Hannah', 'George', 'Lucy', 'Thomas', 'Chloe', 'Sam', 'Megan', 'Ben', 'Ellie', 'Daniel', 'Grace', 'Joe', 'Amy', 'Callum', 'Jess', 'Liam', 'Rosie', 'Alfie', 'Freya', 'Kieran', 'Holly'],
    initials: 'SSJJWWBTDEHCGMRPAL',
  },
  {
    w: 0.15,
    names: ['Kasia', 'Tomasz', 'Andrei', 'Ioana', 'Marco', 'Giulia', 'João', 'Ana', 'Siobhán', 'Ciarán', 'Léa', 'Lucas', 'Pablo', 'Elena', 'Agnieszka', 'Mihai', 'Inês', 'Matteo', 'Aoife', 'Bartek'],
    initials: 'KKNWPCFSRMDOL',
  },
  {
    w: 0.19,
    names: ['Priya', 'Rohan', 'Anjali', 'Sanjay', 'Aisha', 'Imran', 'Fatima', 'Bilal', 'Nusrat', 'Rahim', 'Shreya', 'Kiran', 'Ayesha', 'Zain', 'Tahmina', 'Arjun', 'Hira', 'Sunil', 'Deepa', 'Hamza', 'Thivya', 'Kajan', 'Rukhsana', 'Asif'],
    initials: 'PPSSKKARHMCBIJ',
  },
  {
    w: 0.135,
    names: ['Chidi', 'Adaeze', 'Kwame', 'Abena', 'Tunde', 'Folake', 'Kofi', 'Ama', 'Hodan', 'Abdi', 'Jermaine', 'Shanice', 'Tyrone', 'Leanne', 'Femi', 'Yewande', 'Nana', 'Ayo', 'Michelle', 'Andre', 'Kemi', 'Dami'],
    initials: 'OOAAMBDWJKFEN',
  },
  {
    w: 0.035,
    names: ['Wei', 'Mei', 'Jun', 'Lin', 'Hoa', 'Minh', 'Ji-ho', 'Yuna', 'Chen', 'Xiu', 'Rizal', 'Joy'],
    initials: 'CLWZNTHY',
  },
  {
    w: 0.07,
    names: ['Omar', 'Layla', 'Mehmet', 'Elif', 'Yusuf', 'Zeynep', 'Karim', 'Nour', 'Rojin', 'Diyar', 'Mariana', 'Thiago', 'Hana', 'Emre', 'Valentina', 'Samir'],
    initials: 'YKASDOMEB',
  },
];

const JAPAN: readonly Pool[] = [
  {
    w: 0.97,
    names: ['Haruto', 'Yui', 'Sota', 'Hina', 'Ren', 'Aoi', 'Yuto', 'Sakura', 'Takumi', 'Mio', 'Kenta', 'Yuka', 'Daiki', 'Ayaka', 'Shota', 'Misaki', 'Hiroshi', 'Keiko', 'Takeshi', 'Yoko', 'Kazuya', 'Naomi', 'Ryo', 'Emi', 'Satoshi', 'Tomoko', 'Kenji', 'Akiko'],
    initials: 'SSTTKKWWIINNYYMMHAO',
  },
  {
    w: 0.03,
    names: ['Min-jun', 'Ji-woo', 'Wei', 'Mei', 'Minh', 'Linh', 'Maria', 'Jose', 'Ana', 'Rizal'],
    initials: 'KLPCNSTRG',
  },
];

const POOLS: Record<CityId, readonly Pool[]> = { nyc: NYC, london: LONDON, southeast: LONDON, manchester: LONDON, birmingham: LONDON, leeds: LONDON, bristol: LONDON, japan: JAPAN };

/** Uniform in [0, 1) from a seed and a salt. */
const u01 = (seed: number, salt: number) => hash32x4(seed, salt, 0x6e61, 0x6d65) / 4294967296;

/** The rider's name for a seed (StoryWho.nameSeed): the same seed, the same name, in the city's mix. */
export function riderName(city: CityId, seed: number): { first: string; initial: string; full: string; group: number } {
  const pools = POOLS[city] ?? NYC;
  let total = 0;
  for (const p of pools) total += p.w;
  let x = u01(seed, 1) * total;
  let group = pools.length - 1;
  for (let i = 0; i < pools.length; i++) {
    x -= pools[i].w;
    if (x < 0) {
      group = i;
      break;
    }
  }
  const pool = pools[group];
  const first = pool.names[Math.floor(u01(seed, 2) * pool.names.length)];
  const initial = pool.initials[Math.floor(u01(seed, 3) * pool.initials.length)];
  return { first, initial, full: `${first} ${initial}.`, group };
}

/** How many name groups a city has (tests). */
export function nameGroups(city: CityId): number {
  return (POOLS[city] ?? NYC).length;
}

/** A soft avatar colour for a seed (the story card's initial badge). */
export function avatarColor(seed: number): string {
  const hues = [12, 35, 160, 190, 205, 265, 300, 335];
  const hue = hues[Math.floor(u01(seed, 4) * hues.length)];
  return `hsl(${hue} 55% 46%)`;
}
