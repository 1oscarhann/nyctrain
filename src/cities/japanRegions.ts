/**
 * Japan (the high-speed map): the 46 prefectures of the four main islands and their neighbours
 * (Okinawa is beyond the map), grouped into five areas for charts. A prefecture's land-mask code is
 * its JIS X 0401 number, so Hokkaido is 1 and Kagoshima 46.
 */

export const JP_AREAS = ['Hokkaido & Tohoku', 'Kanto', 'Chubu', 'Kansai', 'West Japan'];

export interface JpPrefecture {
  /** JIS X 0401 code (the land mask code). */
  code: number;
  /** Name in the source data (kanji). */
  ja: string;
  name: string;
  /** Index into JP_AREAS. */
  area: number;
}

export const JP_PREFECTURES: JpPrefecture[] = [
  { code: 1, ja: '北海道', name: 'Hokkaido', area: 0 },
  { code: 2, ja: '青森県', name: 'Aomori', area: 0 },
  { code: 3, ja: '岩手県', name: 'Iwate', area: 0 },
  { code: 4, ja: '宮城県', name: 'Miyagi', area: 0 },
  { code: 5, ja: '秋田県', name: 'Akita', area: 0 },
  { code: 6, ja: '山形県', name: 'Yamagata', area: 0 },
  { code: 7, ja: '福島県', name: 'Fukushima', area: 0 },
  { code: 8, ja: '茨城県', name: 'Ibaraki', area: 1 },
  { code: 9, ja: '栃木県', name: 'Tochigi', area: 1 },
  { code: 10, ja: '群馬県', name: 'Gunma', area: 1 },
  { code: 11, ja: '埼玉県', name: 'Saitama', area: 1 },
  { code: 12, ja: '千葉県', name: 'Chiba', area: 1 },
  { code: 13, ja: '東京都', name: 'Tokyo', area: 1 },
  { code: 14, ja: '神奈川県', name: 'Kanagawa', area: 1 },
  { code: 15, ja: '新潟県', name: 'Niigata', area: 2 },
  { code: 16, ja: '富山県', name: 'Toyama', area: 2 },
  { code: 17, ja: '石川県', name: 'Ishikawa', area: 2 },
  { code: 18, ja: '福井県', name: 'Fukui', area: 2 },
  { code: 19, ja: '山梨県', name: 'Yamanashi', area: 2 },
  { code: 20, ja: '長野県', name: 'Nagano', area: 2 },
  { code: 21, ja: '岐阜県', name: 'Gifu', area: 2 },
  { code: 22, ja: '静岡県', name: 'Shizuoka', area: 2 },
  { code: 23, ja: '愛知県', name: 'Aichi', area: 2 },
  { code: 24, ja: '三重県', name: 'Mie', area: 3 },
  { code: 25, ja: '滋賀県', name: 'Shiga', area: 3 },
  { code: 26, ja: '京都府', name: 'Kyoto', area: 3 },
  { code: 27, ja: '大阪府', name: 'Osaka', area: 3 },
  { code: 28, ja: '兵庫県', name: 'Hyogo', area: 3 },
  { code: 29, ja: '奈良県', name: 'Nara', area: 3 },
  { code: 30, ja: '和歌山県', name: 'Wakayama', area: 3 },
  { code: 31, ja: '鳥取県', name: 'Tottori', area: 4 },
  { code: 32, ja: '島根県', name: 'Shimane', area: 4 },
  { code: 33, ja: '岡山県', name: 'Okayama', area: 4 },
  { code: 34, ja: '広島県', name: 'Hiroshima', area: 4 },
  { code: 35, ja: '山口県', name: 'Yamaguchi', area: 4 },
  { code: 36, ja: '徳島県', name: 'Tokushima', area: 4 },
  { code: 37, ja: '香川県', name: 'Kagawa', area: 4 },
  { code: 38, ja: '愛媛県', name: 'Ehime', area: 4 },
  { code: 39, ja: '高知県', name: 'Kochi', area: 4 },
  { code: 40, ja: '福岡県', name: 'Fukuoka', area: 4 },
  { code: 41, ja: '佐賀県', name: 'Saga', area: 4 },
  { code: 42, ja: '長崎県', name: 'Nagasaki', area: 4 },
  { code: 43, ja: '熊本県', name: 'Kumamoto', area: 4 },
  { code: 44, ja: '大分県', name: 'Oita', area: 4 },
  { code: 45, ja: '宮崎県', name: 'Miyazaki', area: 4 },
  { code: 46, ja: '鹿児島県', name: 'Kagoshima', area: 4 },
];
