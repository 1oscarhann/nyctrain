/**
 * The 207 "living areas" (生活圏) of MLIT's 2015 inter-regional passenger survey (全国幹線旅客純流動調査),
 * for scripts/build-data-japan.ts: each with its prefecture, an English name and a seed point (the
 * main town's centre, lon/lat). The survey publishes the zones as a map, not as a municipality list,
 * so each municipality joins the nearest seed of its own prefecture; in Hokkaido (split into four
 * survey regions) the nearest seed of its own subprefecture (振興局). Tokyo is by code: the 23 special
 * wards are zone 131, the Tama cities and towns 132, the islands 133.
 *
 * `drop`: islands off the four main islands (and Okinawa, beyond the map): no tracts, no trips.
 */

export interface JpZone {
  code: number;
  /** JIS prefecture code. */
  pref: number;
  name: string;
  seed: [number, number];
  /** Hokkaido: the subprefectures (振興局, by the start of their name) whose municipalities may join. */
  sub?: string[];
  drop?: boolean;
}

const Z = (code: number, pref: number, name: string, lon: number, lat: number, extra: Partial<JpZone> = {}): JpZone => ({ code, pref, name, seed: [lon, lat], ...extra });

export const JP_ZONES: JpZone[] = [
  // Hokkaido: 道北 (north)
  Z(11, 1, 'Asahikawa', 142.365, 43.771, { sub: ['上川'] }),
  Z(12, 1, 'Kitami', 143.896, 43.804, { sub: ['オホーツク'] }),
  Z(13, 1, 'Wakkanai', 141.673, 45.416, { sub: ['宗谷'] }),
  Z(14, 1, 'Rumoi', 141.637, 43.941, { sub: ['留萌'] }),
  Z(15, 1, 'Monbetsu', 143.354, 44.356, { sub: ['オホーツク'] }),
  Z(16, 1, 'Nayoro', 142.462, 44.356, { sub: ['上川'] }),
  Z(17, 1, 'Furano', 142.383, 43.342, { sub: ['上川'] }),
  // 道東 (east)
  Z(481, 1, 'Kushiro', 144.381, 42.985, { sub: ['釧路'] }),
  Z(482, 1, 'Obihiro', 143.196, 42.924, { sub: ['十勝'] }),
  Z(483, 1, 'Nemuro', 145.0, 43.5, { sub: ['根室'] }),
  // 道央 (centre)
  Z(491, 1, 'Sapporo', 141.354, 43.062, { sub: ['石狩'] }),
  Z(492, 1, 'Tomakomai', 141.605, 42.634, { sub: ['胆振'] }),
  Z(493, 1, 'Otaru', 140.994, 43.19, { sub: ['後志'] }),
  Z(494, 1, 'Muroran', 140.973, 42.315, { sub: ['胆振'] }),
  Z(495, 1, 'Iwamizawa', 141.776, 43.196, { sub: ['空知'] }),
  Z(496, 1, 'Takikawa', 141.906, 43.558, { sub: ['空知'] }),
  Z(497, 1, 'Fukagawa', 142.024, 43.723, { sub: ['空知'] }),
  Z(498, 1, 'Shizunai', 142.367, 42.341, { sub: ['日高'] }),
  // 道南 (south)
  Z(501, 1, 'Hakodate', 140.729, 41.769, { sub: ['渡島'] }),
  Z(502, 1, 'Esashi', 140.128, 41.869, { sub: ['檜山'] }),
  // Tohoku
  Z(21, 2, 'Aomori', 140.74, 40.822),
  Z(22, 2, 'Hachinohe', 141.488, 40.512),
  Z(23, 2, 'Hirosaki', 140.464, 40.603),
  Z(24, 2, 'Mutsu', 141.183, 41.292),
  Z(31, 3, 'Morioka', 141.153, 39.702),
  Z(32, 3, 'Kitakami', 141.113, 39.287),
  Z(33, 3, 'Ichinoseki', 141.127, 38.934),
  Z(34, 3, 'Miyako', 141.957, 39.641),
  Z(35, 3, 'Kamaishi', 141.8, 39.18),
  Z(41, 4, 'Sendai', 140.872, 38.268),
  Z(42, 4, 'Ishinomaki', 141.302, 38.434),
  Z(43, 4, 'Furukawa', 140.955, 38.571),
  Z(51, 5, 'Akita', 140.103, 39.72),
  Z(52, 5, 'Odate', 140.565, 40.272),
  Z(53, 5, 'Noshiro', 140.027, 40.212),
  Z(54, 5, 'Yokote', 140.567, 39.311),
  Z(61, 6, 'Yamagata', 140.363, 38.24),
  Z(62, 6, 'Shonai', 139.83, 38.82),
  Z(63, 6, 'Yonezawa', 140.116, 37.922),
  Z(64, 6, 'Shinjo', 140.3, 38.765),
  Z(71, 7, 'Fukushima', 140.475, 37.761),
  Z(72, 7, 'Iwaki', 140.888, 37.051),
  Z(73, 7, 'Koriyama', 140.36, 37.4),
  Z(74, 7, 'Aizu', 139.93, 37.495),
  Z(75, 7, 'Soma', 140.957, 37.642),
  Z(76, 7, 'Shirakawa', 140.211, 37.126),
  // Kanto
  Z(81, 8, 'Mito', 140.52, 36.44),
  Z(82, 8, 'Tsuchiura', 140.18, 36.08),
  Z(83, 8, 'Shimodate', 139.85, 36.25),
  Z(84, 8, 'Kashima', 140.645, 35.966),
  Z(91, 9, 'Utsunomiya', 139.884, 36.555),
  Z(92, 9, 'Ashikaga', 139.5, 36.33),
  Z(93, 9, 'Oyama', 139.76, 36.35),
  Z(94, 9, 'Nikko', 139.62, 36.72),
  Z(95, 9, 'Nasu', 140.03, 36.92),
  Z(101, 10, 'Maebashi', 139.03, 36.35),
  Z(102, 10, 'Ota', 139.35, 36.34),
  Z(103, 10, 'Shibukawa', 138.85, 36.52),
  Z(104, 10, 'Numata', 139.044, 36.646),
  Z(111, 11, 'Saitama', 139.645, 35.861),
  Z(112, 11, 'Kawagoe', 139.486, 35.925),
  Z(113, 11, 'Kumagaya', 139.32, 36.18),
  Z(114, 11, 'Chichibu', 139.085, 35.992),
  Z(121, 12, 'Chiba', 140.123, 35.607),
  Z(122, 12, 'Funabashi', 139.983, 35.695),
  Z(123, 12, 'Kimitsu', 139.9, 35.2),
  Z(124, 12, 'Narita', 140.318, 35.776),
  Z(131, 13, 'Tokyo 23 wards', 139.75, 35.69),
  Z(132, 13, 'Tama', 139.4, 35.68),
  Z(133, 13, 'Izu Islands', 139.4, 34.3, { drop: true }),
  Z(141, 14, 'Yokohama', 139.638, 35.444),
  Z(142, 14, 'Kawasaki', 139.703, 35.531),
  Z(143, 14, 'Sagamihara', 139.373, 35.571),
  Z(144, 14, 'Odawara', 139.159, 35.264),
  // Chubu
  Z(151, 15, 'Niigata', 139.036, 37.916),
  Z(152, 15, 'Nagaoka', 138.851, 37.446),
  Z(153, 15, 'Joetsu', 138.236, 37.148),
  Z(154, 15, 'Sanjo', 138.94, 37.65),
  Z(155, 15, 'Uonuma', 138.92, 37.15),
  Z(156, 15, 'Murakami', 139.48, 38.224),
  Z(157, 15, 'Sado', 138.4, 38.02, { drop: true }),
  Z(161, 16, 'Toyama', 137.211, 36.696),
  Z(162, 16, 'Takaoka', 137.026, 36.754),
  Z(163, 16, 'Uozu', 137.43, 36.85),
  Z(164, 16, 'Tonami', 136.962, 36.648),
  Z(171, 17, 'Kanazawa', 136.626, 36.561),
  Z(172, 17, 'Nanao', 136.967, 37.043),
  Z(173, 17, 'Wajima', 136.899, 37.39),
  Z(181, 18, 'Fukui', 136.222, 36.064),
  Z(182, 18, 'Echizen', 136.18, 35.92),
  Z(183, 18, 'Tsuruga', 135.95, 35.6),
  Z(191, 19, 'Kofu', 138.568, 35.662),
  Z(192, 19, 'Fujiyoshida', 138.85, 35.55),
  Z(193, 19, 'Hokuto', 138.4, 35.78),
  Z(201, 20, 'Nagano', 138.181, 36.649),
  Z(202, 20, 'Matsumoto', 137.972, 36.238),
  Z(203, 20, 'Ueda', 138.3, 36.35),
  Z(204, 20, 'Iida', 137.822, 35.515),
  Z(205, 20, 'Suwa', 138.05, 35.95),
  Z(211, 21, 'Gifu', 136.723, 35.423),
  Z(212, 21, 'Ogaki', 136.613, 35.36),
  Z(213, 21, 'Tajimi', 137.25, 35.4),
  Z(214, 21, 'Minokamo', 137.016, 35.44),
  Z(215, 21, 'Takayama', 137.252, 36.146),
  Z(221, 22, 'Shizuoka', 138.383, 34.976),
  Z(222, 22, 'Hamamatsu', 137.727, 34.711),
  Z(223, 22, 'Numazu', 138.8, 35.1),
  Z(231, 23, 'Nagoya', 136.907, 35.181),
  Z(232, 23, 'Toyohashi', 137.392, 34.769),
  Z(233, 23, 'Toyota', 137.156, 35.03),
  // Kansai
  Z(241, 24, 'Tsu', 136.5, 34.65),
  Z(242, 24, 'Yokkaichi', 136.624, 34.965),
  Z(243, 24, 'Ise', 136.709, 34.487),
  Z(244, 24, 'Iga', 136.13, 34.769),
  Z(245, 24, 'Owase', 136.191, 34.071),
  Z(251, 25, 'Otsu', 135.9, 35.0),
  Z(252, 25, 'Hikone', 136.26, 35.33),
  Z(253, 25, 'Omihachiman', 136.13, 35.11),
  Z(261, 26, 'Kyoto', 135.768, 35.012),
  Z(262, 26, 'Uji', 135.8, 34.884),
  Z(263, 26, 'Fukuchiyama', 135.25, 35.4),
  Z(264, 26, 'Kameoka', 135.573, 35.013),
  Z(265, 26, 'Kizugawa', 135.82, 34.74),
  Z(271, 27, 'Osaka', 135.502, 34.694),
  Z(272, 27, 'Sakai', 135.483, 34.573),
  Z(273, 27, 'Higashiosaka', 135.601, 34.679),
  Z(274, 27, 'Toyonaka', 135.469, 34.782),
  Z(281, 28, 'Kobe', 135.196, 34.69),
  Z(282, 28, 'Amagasaki', 135.39, 34.74),
  Z(283, 28, 'Himeji', 134.686, 34.816),
  Z(284, 28, 'Toyooka', 134.82, 35.544),
  Z(285, 28, 'Awaji', 134.84, 34.36),
  Z(286, 28, 'Tamba', 135.1, 35.13),
  Z(291, 29, 'Nara', 135.805, 34.685),
  Z(292, 29, 'Gojo', 135.75, 34.25),
  Z(301, 30, 'Wakayama', 135.171, 34.226),
  Z(302, 30, 'Tanabe', 135.377, 33.728),
  Z(303, 30, 'Shingu', 135.993, 33.724),
  // West Japan: Chugoku
  Z(311, 31, 'Tottori', 134.235, 35.501),
  Z(312, 31, 'Yonago', 133.331, 35.428),
  Z(313, 31, 'Kurayoshi', 133.826, 35.43),
  Z(321, 32, 'Matsue', 133.05, 35.468),
  Z(322, 32, 'Izumo', 132.755, 35.367),
  Z(323, 32, 'Masuda', 131.843, 34.675),
  Z(324, 32, 'Hamada', 132.08, 34.899),
  Z(325, 32, 'Oda', 132.5, 35.192),
  Z(331, 33, 'Okayama', 133.86, 34.63),
  Z(332, 33, 'Tsuyama', 134.004, 35.069),
  Z(341, 34, 'Hiroshima', 132.459, 34.385),
  Z(342, 34, 'Fukuyama', 133.362, 34.486),
  Z(343, 34, 'Miyoshi', 132.852, 34.805),
  Z(351, 35, 'Yamaguchi', 131.474, 34.178),
  Z(352, 35, 'Shimonoseki', 130.941, 33.958),
  Z(353, 35, 'Ube', 131.246, 33.952),
  Z(354, 35, 'Iwakuni', 132.219, 34.167),
  Z(355, 35, 'Shunan', 131.806, 34.055),
  Z(356, 35, 'Hagi', 131.399, 34.408),
  // Shikoku
  Z(361, 36, 'Tokushima', 134.555, 34.07),
  Z(362, 36, 'Miyoshi (Tokushima)', 133.807, 34.026),
  Z(363, 36, 'Anan', 134.6, 33.85),
  Z(371, 37, 'Takamatsu', 134.047, 34.34),
  Z(372, 37, 'Marugame', 133.75, 34.2),
  Z(381, 38, 'Matsuyama', 132.766, 33.839),
  Z(382, 38, 'Niihama', 133.23, 33.93),
  Z(383, 38, 'Imabari', 132.998, 34.066),
  Z(384, 38, 'Uwajima', 132.56, 33.223),
  Z(385, 38, 'Yawatahama', 132.5, 33.48),
  Z(391, 39, 'Kochi', 133.531, 33.559),
  Z(392, 39, 'Shimanto', 132.93, 32.95),
  Z(393, 39, 'Susaki', 133.283, 33.401),
  Z(394, 39, 'Aki', 133.907, 33.502),
  // Kyushu
  Z(401, 40, 'Fukuoka', 130.402, 33.59),
  Z(402, 40, 'Kitakyushu', 130.882, 33.883),
  Z(403, 40, 'Kurume', 130.5, 33.2),
  Z(404, 40, 'Iizuka', 130.691, 33.646),
  Z(411, 41, 'Saga', 130.299, 33.249),
  Z(412, 41, 'Karatsu', 129.968, 33.45),
  Z(413, 41, 'Imari', 129.881, 33.265),
  Z(421, 42, 'Nagasaki', 129.873, 32.75),
  Z(422, 42, 'Sasebo', 129.724, 33.18),
  Z(423, 42, 'Goto', 128.84, 32.7, { drop: true }),
  Z(424, 42, 'Kitamatsu', 129.65, 33.35),
  Z(425, 42, 'Tsushima', 129.29, 34.2, { drop: true }),
  Z(426, 42, 'Iki', 129.69, 33.75, { drop: true }),
  Z(431, 43, 'Kumamoto', 130.742, 32.803),
  Z(432, 43, 'Yatsushiro', 130.6, 32.4),
  Z(433, 43, 'Amakusa', 130.193, 32.459),
  Z(434, 43, 'Hitoyoshi', 130.762, 32.21),
  Z(441, 44, 'Oita', 131.612, 33.238),
  Z(442, 44, 'Nakatsu', 131.25, 33.55),
  Z(443, 44, 'Hita', 130.941, 33.321),
  Z(444, 44, 'Saiki', 131.901, 32.96),
  Z(451, 45, 'Miyazaki', 131.424, 31.911),
  Z(452, 45, 'Miyakonojo', 131.061, 31.72),
  Z(453, 45, 'Nobeoka', 131.665, 32.582),
  Z(454, 45, 'Nichinan', 131.379, 31.602),
  Z(455, 45, 'Kobayashi', 130.973, 31.997),
  Z(461, 46, 'Kagoshima', 130.558, 31.596),
  Z(462, 46, 'Satsumasendai', 130.29, 31.77),
  Z(463, 46, 'Kanoya', 130.852, 31.378),
  Z(464, 46, 'Amami', 129.49, 28.38, { drop: true }),
  Z(465, 46, 'Ibusuki', 130.4, 31.35),
  Z(466, 46, 'Kumage', 130.6, 30.5, { drop: true }),
  // Okinawa (beyond the map)
  Z(471, 47, 'Naha', 127.68, 26.21, { drop: true }),
  Z(472, 47, 'Okinawa Central', 127.8, 26.33, { drop: true }),
  Z(473, 47, 'Nago', 127.98, 26.59, { drop: true }),
  Z(474, 47, 'Miyako & Yaeyama', 125.28, 24.8, { drop: true }),
];

/**
 * Islands off the main islands that belong to a kept zone but sit far offshore. Their
 * municipalities (by the start of their N03 name) have no tracts: no station could reach them.
 */
export const JP_DROP_MUNICIPALITIES: { pref: number; names: string[] }[] = [
  { pref: 1, names: ['礼文町', '利尻町', '利尻富士町', '奥尻町'] },
  { pref: 13, names: ['大島町', '利島村', '新島村', '神津島村', '三宅村', '御蔵島村', '八丈町', '青ヶ島村', '小笠原村'] },
  { pref: 15, names: ['佐渡市', '粟島浦村'] },
  { pref: 32, names: ['隠岐の島町', '海士町', '西ノ島町', '知夫村'] },
  { pref: 42, names: ['五島市', '新上五島町', '小値賀町', '対馬市', '壱岐市'] },
  { pref: 46, names: ['西之表市', '中種子町', '南種子町', '屋久島町', '三島村', '十島村', '奄美市', '大和村', '宇検村', '瀬戸内町', '龍郷町', '喜界町', '徳之島町', '天城町', '伊仙町', '和泊町', '知名町', '与論町'] },
];

/**
 * The survey leaves out trips inside a prefecture (Hokkaido: inside one of its four regions) and
 * inside the three big metropolitan areas. Those zone pairs at least this far apart get modelled
 * trips (a gravity model fitted to the survey's own pairs), so Fukuoka–Kitakyushu or
 * Shizuoka–Hamamatsu are not empty.
 */
export const JP_METROS: number[][] = [
  [11, 12, 13, 14], // Tokyo: Saitama, Chiba, Tokyo, Kanagawa
  [21, 23, 24], // Chukyo: Gifu, Aichi, Mie
  [26, 27, 28, 29], // Kinki: Kyoto, Osaka, Hyogo, Nara (Shiga and Wakayama trips are in the survey)
];
