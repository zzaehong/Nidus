# AGENTS.md

이 문서는 Nidus 저장소에서 작업하는 AI 개발 에이전트를 위한 기본 지침이다.

작업 전에 반드시 현재 `develop` 브랜치와 이 문서를 확인한다.

---

## 1. Nidus의 목적

Nidus는 단순한 AI 챗봇이나 여러 모델을 묶은 인터페이스가 아니다.

궁극적으로는 사용자의 로컬 환경 안에서 지속적으로 활동하는 **AI Office**를 만드는 것이 목표다.

핵심 개념은 다음 문서를 기준으로 한다.

- `docs/CONCEPT.md` — Nidus의 핵심 철학, Agent Vault, AI Office
- `README.md` — 현재 프로젝트의 간단한 설명
- `docs/Git_Flow.md` — Git 작업 규칙

`docs/CONCEPT.md`는 장기적인 제품 방향을 설명한다.
이를 현재 구현 상태라고 가정하지 않는다.

---

## 2. 현재 개발 단계

현재 Nidus는 기존 구현을 정리하고 처음부터 다시 구축하는 단계다.

개발 순서는 다음과 같다.

```text
1. AI API Routing Core
        ↓
2. Nidus Backend API
        ↓
3. Frontend Dashboard
        ↓
4. AI Office Runtime 확장