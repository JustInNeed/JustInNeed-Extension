/* =============================================================================
 * background.js — 실사용 버전의 service worker 입구
 *
 * 엔진(bg-core.js, recorder-core/ 에서 합쳐짐)을 먼저, 이 버전의 부분(bg-service.js)을 뒤에 올린다.
 * 리스너는 importScripts 안에서 최상위로 동기 등록된다. 설계는 두 파일 맨 위 주석.
 * ========================================================================== */
/* global importScripts */   // service worker 전역
importScripts('bg-core.js', 'bg-service.js');
