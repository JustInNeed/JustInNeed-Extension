/* =============================================================================
 * bg-service.js — 실사용 버전의 background 부분 (#19 빈 껍데기)
 *
 * 엔진(recorder-core/bg-core.js) 뒤에 올라간다(background.js 의 importScripts 순서).
 * 테스트 기능이 없다 — 동의 · 참여 번호 · 끝 질문 · 평정 · 설문(10-30 서현). 시작 허락 조건 = 로그인(bg-auth.js).
 * 내보내기(패널 [내보내기])는 엔진 명령이라 그대로 쓴다(10-31 서현).
 *
 * 지금 하는 것: mode 'server'. 로그인 · 시작 허락 · tester 는 bg-auth.js(#30), 자르기 · 보내기는 bg-sink.js(#34).
 *   엔진 start 는 여전히 직전 로그를 지운다 — 그 전에 bg-sink 가 남은 기록을 보낼 상자로 옮긴다.
 * ========================================================================== */
/* global VERSION */
'use strict';

Object.assign(VERSION, {
  mode: 'server',
});
