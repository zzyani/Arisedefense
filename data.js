'use strict';

/* ==================================================================
 * ARISE: 그림자 군단 디펜스 — data.js
 *  밸런스·콘텐츠 데이터만 모은 파일. 수치 조정·챕터 추가는 여기만 수정합니다.
 *  index.html에서 game.js보다 먼저 불러오며, game.js의 규칙·화면 코드가 이 값을 읽습니다.
 * ================================================================== */

/* ==================================================================
 * GAME_DATA
 *  - 좌표 단위는 전장 좌표(960×588 기준), 시간 단위는 초
 *  - spawn 값은 적 출현 지점 번호 (0 북, 1 동, 2 남, 3 서)
 *  - 데이터를 잘못 수정하면 게임 시작 전에 화면에 오류 목록이 표시됩니다.
 * ================================================================== */
const GAME_DATA = {
  config: {
    startEnergy: 100,
    maxEnergy: 150,
    killReward: 10,
    waveStartBonus: 20,    // 2웨이브부터 [웨이브 시작]을 누를 때 지급
    recallRefundRate: 1.0, // 회수 시 환불 비율 (1.0 = 전액). 이번 준비 단계에서 배치한 기본 그림자만 회수 가능
    dismantleRefundRate: 0.5, // 해체 시 반환 비율. 생성 때 실제 소비한 에너지 기준, 반올림 (SD-DISMANTLE)
    coreHp: 200,           // 거점 최대 HP. 거점에 붙은 적이 공격 간격마다 공격력만큼 깎음
    maxArmy: 15,           // 전체 군단 최대 수 (기본 + 추출)
    maxBasic: 4,           // 기본 그림자 최대 수 (처음부터 쓰는 카드 기준). 챕터 보상으로 카드가 1장 늘 때마다 +1
    fixedStep: 1 / 60,     // 전투 계산 간격(초). 바꾸지 않는 것을 권장
    unlockAllChapters: true, // 테스트용: true면 클리어 여부와 상관없이 모든 챕터를 열어 둠 (출시 전 false로). 카드 해금은 그대로 클리어 기준
  },

  // 맵 이미지(1602×981)를 가로 960에 맞춘 크기. 거점 = 맵 중앙 문양 중심
  field: {
    width: 960,
    height: 588,
    core: { x: 480, y: 295, radius: 45 },
    spawnPoints: [
      // 아래 두 값은 표시 전용 (게임 규칙과 무관)
      //  revealTop: 이 y보다 위쪽은 그리지 않아 적이 석상 턱 아래 벽에서 걸어 나오는 것처럼 보임
      //  crack: 맵 이미지에서 이 출현 지점의 푸른 균열이 있는 영역 → 빛나는 연출에 사용
      { id: 'N', label: '북', x: 480, y: 60, revealTop: 64, crack: { x: 405, y: 58, w: 120, h: 92 } },   // 석상 턱 바로 아래 (거점까지 235)
      { id: 'E', label: '동', x: 936, y: 295, crack: { x: 810, y: 260, w: 140, h: 72 } },  // 거점까지 456
      { id: 'S', label: '남', x: 480, y: 541, crack: { x: 418, y: 405, w: 110, h: 150 } }, // 아래쪽 출입구 (거점까지 246)
      { id: 'W', label: '서', x: 24,  y: 295, crack: { x: 10, y: 260, w: 140, h: 72 } },   // 거점까지 456
    ],
    // 기본 그림자 배치 제한 (추출 그림자는 맵 범위만 검사)
    placement: {
      coreClear: 70,     // 거점 중심 70px 이내 불가
      spawnClear: 50,    // 적 출현 지점 50px 이내 불가
      edgeClear: 20,     // 맵 경계 20px 이내 불가
      basicSpacing: 35,  // 기존 기본 그림자 35px 이내 불가
    },
    unitMargin: 12,      // 움직이는 유닛이 맵 경계 안쪽에 머무는 여백
  },

  // 기본 소환 그림자: 원하는 위치에 배치하는 고정형 방어 병력
  //  targetType: single(한 명) · all_in_range(사거리 안 전부) · splash(한 명 + 그 주변 splashRadius 안 전부)
  //  unlockAfterChapter: 그 챕터를 클리어하면 카드가 생김 (없으면 처음부터 사용). 카드가 늘 때마다 기본 그림자 최대 수 +1
  //  cardImage·attackFx·스프라이트가 없으면 카드는 색 띠만, 공격은 기본 연출(공격 선·탄환·폭발 원)로 표시
  shadows: [
    { id: 'SH_001', name: '아이언',   role: 'tank',   cost: 30, maxHp: 300, attack: 20, attackInterval: 1.5, attackRange: 100, targetType: 'single',       color: '#4f86ff', attackFx: 'slam', cardImage: 'assets/cards/sh_001.webp' },
    { id: 'SH_002', name: '이그리트', role: 'damage', cost: 50, maxHp: 150, attack: 65, attackInterval: 1.0, attackRange: 80,  targetType: 'single',       color: '#a66bff', attackFx: 'slash', cardImage: 'assets/cards/sh_002.webp' },
    { id: 'SH_003', name: '탱크',     role: 'area',   cost: 40, maxHp: 220, attack: 35, attackInterval: 2.0, attackRange: 110, targetType: 'all_in_range', color: '#2ec4b6', attackFx: 'bearclaw', cardImage: 'assets/cards/sh_003.webp' },
    { id: 'SH_004', name: '어금니',   role: 'magic',  cost: 45, maxHp: 120, attack: 38, attackInterval: 1.6, attackRange: 170, targetType: 'single',       color: '#ff8a3d', attackFx: 'bolt',  unlockAfterChapter: 3 },
    { id: 'SH_005', name: '카이셀',   role: 'area',   cost: 55, maxHp: 180, attack: 28, attackInterval: 2.2, attackRange: 150, targetType: 'splash', splashRadius: 55, color: '#5fd0ff', attackFx: 'blast', unlockAfterChapter: 4 },
    { id: 'SH_006', name: '베르',     role: 'speed',  cost: 50, maxHp: 200, attack: 20, attackInterval: 0.45, attackRange: 70, targetType: 'single',       color: '#b8f04a', unlockAfterChapter: 5 },
  ],

  // 적. targetType: 없으면 한 명, all_in_range면 사거리 안 그림자 전부
  //  coreStandoff: 거점에 붙지 않고 이만큼 떨어진 둘레에서 거점을 공격 (원거리형)
  //  moveWhileAttacking: 사거리 안 그림자를 쏘면서도 멈추지 않고 거점 쪽으로 계속 이동 (사거리 밖에서 버티며 웨이브가 늘어지지 않게)
  //  모습은 챕터마다 바꿀 수 있음 → game.js SPRITES에 'EN_001@ch2' 같은 이름으로 넣으면 그 챕터에서 사용
  enemies: [
    { id: 'EN_001', name: '일반형',   maxHp: 100, attack: 15, moveSpeed: 35, attackInterval: 2.0, attackRange: 45, radius: 14, color: '#d99a3e', attackFx: 'claw' },
    { id: 'EN_002', name: '돌격형',   maxHp: 70,  attack: 12, moveSpeed: 65, attackInterval: 1.5, attackRange: 45, radius: 12, color: '#ff5d73', attackFx: 'ice' },
    { id: 'EN_003', name: '중장갑형', maxHp: 260, attack: 30, moveSpeed: 20, attackInterval: 2.5, attackRange: 45, radius: 18, color: '#b07a5a', attackFx: 'bite' },
    { id: 'EN_004', name: '원거리형', maxHp: 75,  attack: 12, moveSpeed: 30, attackInterval: 2.0, attackRange: 120, radius: 13, color: '#e8a33a', attackFx: 'bolt', coreStandoff: 45, moveWhileAttacking: true },   // 챕터 3부터
    { id: 'EN_005', name: '광역형',   maxHp: 200, attack: 16, moveSpeed: 24, attackInterval: 2.4, attackRange: 60,  radius: 17, color: '#d0453c', attackFx: 'blast', targetType: 'all_in_range' },   // 챕터 4부터
    { id: 'EN_006', name: '스피드형', maxHp: 55,  attack: 8,  moveSpeed: 100, attackInterval: 0.8, attackRange: 40, radius: 11, color: '#7fdc5a' },   // 챕터 5부터
  ],

  // 그림자 추출: 적 사망 위치에 잔영 생성 → 플레이어가 선택·에너지 지불 → 자동 추적형 그림자
  extraction: {
    remnantChance: 1.0,     // 잔영 생성 확률 (1.0 = 100%)
    remnantDuration: 12,    // 잔영 지속 시간(초). 전투 중에만 줄어듦
    detectionRadius: 180,   // 그림자 기준 적 탐색 반경
    maxRoamRadius: 220,     // 생성 위치(origin) 기준 최대 이동 반경
    returnThreshold: 20,    // 추격 대상이 없고 원점에서 이만큼 떨어지면 복귀
    spawnDelay: 0.5,        // 추출 직후 행동 시작까지(초)
    units: [
      { sourceEnemyId: 'EN_001', cost: 10, maxHp: 80,  attack: 23, moveSpeed: 55, attackRange: 35, attackInterval: 1.5 },
      { sourceEnemyId: 'EN_002', cost: 15, maxHp: 56,  attack: 18, moveSpeed: 90, attackRange: 35, attackInterval: 1.2 },
      { sourceEnemyId: 'EN_003', cost: 25, maxHp: 208, attack: 45, moveSpeed: 35, attackRange: 35, attackInterval: 2.0 },
      { sourceEnemyId: 'EN_004', cost: 20, maxHp: 64,  attack: 20, moveSpeed: 50, attackRange: 110, attackInterval: 1.8 },
      { sourceEnemyId: 'EN_005', cost: 25, maxHp: 160, attack: 22, moveSpeed: 40, attackRange: 50, attackInterval: 2.0, targetType: 'all_in_range' },
      { sourceEnemyId: 'EN_006', cost: 15, maxHp: 44,  attack: 12, moveSpeed: 120, attackRange: 35, attackInterval: 0.8 },
    ],
  },

  // 챕터: 챕터마다 웨이브 5개. 앞 챕터를 클리어하면 다음 챕터가 해금됨 (진행·기록은 브라우저에 저장)
  //  theme: 배경. map = 맵 그림 경로(못 불러오면 기본 맵 assets/map.webp로 대신 표시), tint = 맵 위에 덮는 색(선택)
  //         맵 그림은 기본 맵과 같은 배치여야 함: 1602×981, 가운데 문양 중심 = (801, 491.5), 북·동·남·서 네 출입구
  //         (assets/maps/는 받은 그림을 문양 중심 기준으로 잘라 이 배치에 맞춘 것)
  //         decor: 'temple'이면 기본 맵용 불꽃·석상 눈빛·균열 빛 연출을 켬 (다른 맵에서는 위치가 맞지 않음)
  // 적은 배열 순서대로 spawnInterval 간격으로 생성됩니다 (첫 적은 웨이브 시작 즉시).
  // 북·남 출현 지점은 거점과 가까워(약 235px) 동·서(약 456px)보다 빨리 도착합니다.
  chapters: [
    { chapterId: 1, name: '카르테논 신전', desc: '늑대와 얼음 기수가 몰려오는 첫 관문',
      theme: { map: 'assets/map.webp', decor: 'temple' }, waves: [
      { waveId: 1, spawnInterval: 2.5, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 },
      ] },
      { waveId: 2, spawnInterval: 2.2, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 },
      ] },
      { waveId: 3, spawnInterval: 2.0, enemies: [
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 0 },
        { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_001', spawn: 2 },
      ] },
      { waveId: 4, spawnInterval: 1.8, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
      ] },
      { waveId: 5, spawnInterval: 1.6, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_002', spawn: 3 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_003', spawn: 0 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 },
      ] },
    ] },
    { chapterId: 2, name: '설원 숲', desc: '코브라가 섞여 사방에서 동시에 밀려오는 눈 덮인 숲',
      theme: { map: 'assets/maps/ch2.webp' }, waves: [
      { waveId: 1, spawnInterval: 2.2, enemies: [
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 },
      ] },
      { waveId: 2, spawnInterval: 2.0, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 },
        { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 },
      ] },
      { waveId: 3, spawnInterval: 1.9, enemies: [
        { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 3 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_001', spawn: 1 },
      ] },
      { waveId: 4, spawnInterval: 1.7, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_003', spawn: 0 },
        { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_003', spawn: 1 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 0 },
      ] },
      { waveId: 5, spawnInterval: 1.5, enemies: [
        { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_003', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_003', spawn: 2 },
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_001', spawn: 2 },
      ] },
    ] },
    { chapterId: 3, name: '오크 주둔지', desc: '멀리서 쏘는 원거리형이 처음 나타나는 주둔지',
      theme: { map: 'assets/maps/ch3.webp' }, waves: [
      { waveId: 1, spawnInterval: 2.2, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_004', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 },
      ] },
      { waveId: 2, spawnInterval: 2.0, enemies: [
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_004', spawn: 2 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_003', spawn: 2 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_002', spawn: 2 },
        { enemyId: 'EN_001', spawn: 0 },
      ] },
      { waveId: 3, spawnInterval: 1.9, enemies: [
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_004', spawn: 3 },
        { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 },
        { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 3 },
        { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 },
      ] },
      { waveId: 4, spawnInterval: 1.8, enemies: [
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_004', spawn: 1 },
        { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_004', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_001', spawn: 3 },
      ] },
      { waveId: 5, spawnInterval: 1.6, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_003', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_004', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_003', spawn: 0 },
        { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_004', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_003', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_004', spawn: 1 },
        { enemyId: 'EN_001', spawn: 0 },
      ] },
    ] },
    { chapterId: 4, name: '악마성', desc: '주변을 한꺼번에 치는 광역형이 지키는 성',
      theme: { map: 'assets/maps/ch4.webp' }, waves: [
      { waveId: 1, spawnInterval: 2.0, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_005', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_004', spawn: 3 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 },
      ] },
      { waveId: 2, spawnInterval: 1.8, enemies: [
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_004', spawn: 2 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 },
        { enemyId: 'EN_003', spawn: 0 }, { enemyId: 'EN_005', spawn: 1 }, { enemyId: 'EN_001', spawn: 2 },
        { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 },
      ] },
      { waveId: 3, spawnInterval: 1.7, enemies: [
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_004', spawn: 3 },
        { enemyId: 'EN_005', spawn: 1 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_003', spawn: 0 }, { enemyId: 'EN_004', spawn: 3 },
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_005', spawn: 0 }, { enemyId: 'EN_002', spawn: 2 },
        { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_001', spawn: 0 },
      ] },
      { waveId: 4, spawnInterval: 1.6, enemies: [
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_004', spawn: 1 },
        { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_005', spawn: 0 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_004', spawn: 1 },
        { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_003', spawn: 0 },
        { enemyId: 'EN_005', spawn: 3 }, { enemyId: 'EN_004', spawn: 2 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_001', spawn: 1 },
      ] },
      { waveId: 5, spawnInterval: 1.4, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_005', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_003', spawn: 0 },
        { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_004', spawn: 3 }, { enemyId: 'EN_001', spawn: 0 },
        { enemyId: 'EN_005', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_004', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_003', spawn: 1 },
        { enemyId: 'EN_005', spawn: 0 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_004', spawn: 1 },
        { enemyId: 'EN_001', spawn: 0 },
      ] },
    ] },
    { chapterId: 5, name: '개미굴', desc: '빠르게 파고드는 스피드형이 떼로 몰려오는 굴',
      theme: { map: 'assets/maps/ch5.webp' }, waves: [
      { waveId: 1, spawnInterval: 1.8, enemies: [
        { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 0 },
        { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 1 },
      ] },
      { waveId: 2, spawnInterval: 1.7, enemies: [
        { enemyId: 'EN_006', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 },
        { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 },
        { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_005', spawn: 1 }, { enemyId: 'EN_006', spawn: 2 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 3 },
        { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_006', spawn: 3 },
      ] },
      { waveId: 3, spawnInterval: 1.6, enemies: [
        { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 },
        { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_006', spawn: 1 }, { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 3 },
        { enemyId: 'EN_005', spawn: 1 }, { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 },
        { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_006', spawn: 2 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 0 },
      ] },
      { waveId: 4, spawnInterval: 1.5, enemies: [
        { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_004', spawn: 3 }, { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_005', spawn: 1 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_003', spawn: 2 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 0 },
        { enemyId: 'EN_005', spawn: 1 }, { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 0 },
      ] },
      { waveId: 5, spawnInterval: 1.3, enemies: [
        { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_004', spawn: 2 }, { enemyId: 'EN_005', spawn: 1 }, { enemyId: 'EN_006', spawn: 0 },
        { enemyId: 'EN_003', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_004', spawn: 1 },
        { enemyId: 'EN_005', spawn: 2 }, { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_006', spawn: 1 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_006', spawn: 1 },
        { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_004', spawn: 2 }, { enemyId: 'EN_005', spawn: 1 },
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_006', spawn: 2 },
      ] },
    ] },
    { chapterId: 6, name: '카르테논 신전', desc: '모든 적이 다시 모여드는 마지막 결전',
      theme: { map: 'assets/maps/ch6.webp' }, waves: [
      { waveId: 1, spawnInterval: 1.9, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 },
        { enemyId: 'EN_005', spawn: 2 }, { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_001', spawn: 0 },
        { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
      ] },
      { waveId: 2, spawnInterval: 1.6, enemies: [
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 },
        { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_005', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 },
        { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_003', spawn: 2 },
        { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_006', spawn: 3 },
        { enemyId: 'EN_005', spawn: 0 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 3 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_006', spawn: 1 },
      ] },
      { waveId: 3, spawnInterval: 1.5, enemies: [
        { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 },
        { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_003', spawn: 2 }, { enemyId: 'EN_005', spawn: 3 },
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_001', spawn: 3 },
        { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_006', spawn: 2 },
        { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_003', spawn: 2 },
        { enemyId: 'EN_005', spawn: 3 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_004', spawn: 2 },
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 1 },
      ] },
      { waveId: 4, spawnInterval: 1.4, enemies: [
        { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_004', spawn: 3 }, { enemyId: 'EN_005', spawn: 0 }, { enemyId: 'EN_003', spawn: 1 },
        { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 },
        { enemyId: 'EN_004', spawn: 3 }, { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_001', spawn: 0 },
        { enemyId: 'EN_005', spawn: 3 }, { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_003', spawn: 0 },
        { enemyId: 'EN_006', spawn: 1 }, { enemyId: 'EN_005', spawn: 3 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 2 },
      ] },
      { waveId: 5, spawnInterval: 1.2, enemies: [
        { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_006', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_003', spawn: 2 }, { enemyId: 'EN_004', spawn: 1 }, { enemyId: 'EN_005', spawn: 0 },
        { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_006', spawn: 3 }, { enemyId: 'EN_002', spawn: 0 },
        { enemyId: 'EN_003', spawn: 2 }, { enemyId: 'EN_004', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_006', spawn: 2 }, { enemyId: 'EN_005', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
        { enemyId: 'EN_006', spawn: 0 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_003', spawn: 1 },
        { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_006', spawn: 1 },
        { enemyId: 'EN_005', spawn: 0 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_003', spawn: 3 },
        { enemyId: 'EN_004', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_006', spawn: 3 },
      ] },
    ] },
  ],
};


