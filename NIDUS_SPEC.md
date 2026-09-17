# Nidus — Living Specification

> 이 문서는 Nidus의 제품 정의, 요구사항, 기술 설계, 구현 계획을 관리하는 단일 Source of Truth다.
> 
> 확정되지 않은 사항은 임의로 결정하지 않는다.  
> 새로운 결정은 **Proposal → Discussion → Approval → Confirmed** 순서로 반영한다.

---

# 0. Document Rules

## 0.1 Decision States

모든 중요한 내용은 다음 상태 중 하나로 관리한다.

- **Confirmed** — 이미 합의된 내용
    
- **Proposed** — 검토를 위해 제안된 내용
    
- **Open** — 아직 결정하지 않은 내용
    
- **Deferred** — 현재 범위에서는 결정하지 않는 내용
    
- **Rejected** — 검토 후 채택하지 않은 내용
    

HTML `nidus_overview.html`에 명시된 제품 철학과 세계관은 기본적으로 Confirmed로 취급한다.

그 외 제품 범위, UX, 기술, 데이터, 인프라, 구현 방식은 사용자의 승인 없이 Confirmed로 변경하지 않는다.

---

# 1. Product Definition

## 1.1 Product

**Nidus**

Personal AI Operating Environment

## 1.2 Definition

Nidus는 AI가 살아가며 일할 수 있는 개인용 디지털 환경이다.

Agent Vault라는 격리된 디지털 공간 안에 AI Office를 만들고, 그 안에서 AI Employee가 사용자의 지식과 프로젝트를 활용하여 실제 업무를 수행한다.

인간 관리자는 목표와 방향을 설정하며 언제든 AI의 업무, 우선순위, 판단에 개입할 수 있다.

**Status: Confirmed**

---

# 2. Product Principles

## 2.1 Human = Direction

인간은 목표와 방향을 정하고 최종 통제권을 가진다.

**Status: Confirmed**

## 2.2 AI = Execution

AI는 단순히 행동을 제안하는 것이 아니라 실제 업무를 수행한다.

**Status: Confirmed**

## 2.3 Environment First

Nidus의 핵심 자산은 특정 AI 모델이 아니라 AI가 지속적으로 일할 수 있는 환경이다.

**Status: Confirmed**

## 2.4 Knowledge is Shared

사용자의 지식은 인간과 AI가 함께 활용하는 공용 자산이다.

**Status: Confirmed**

## 2.5 Rest is Part of Work

생각을 즉시 실행하지 않고 숙성하고 다시 검토하는 과정 역시 업무의 일부다.

**Status: Confirmed**

---

# 3. Conceptual World Model

Nidus는 세 개의 주요 계층으로 구성된다.

## 3.1 Agent Vault

AI가 존재하는 격리된 디지털 세계.

컴퓨터 전체가 아니라 사용자가 허용한 하나의 경계를 AI의 활동 공간으로 사용한다.

**Status: Confirmed**

## 3.2 AI Office

Agent Vault 내부에서 인간과 AI가 함께 일하기 위한 조직 및 운영 환경.

**Status: Confirmed**

## 3.3 AI Employee

AI Office에서 실제 업무를 수행하는 작업 주체.

특정 모델 자체가 Employee의 정체성이 아니며 모델이 변경되더라도 Vault의 지식과 상태를 이어받을 수 있어야 한다.

**Status: Confirmed**

---

# 4. AI Office

AI Office에는 다음 11개의 개념적 공간이 존재한다.

1. Home
    
2. Library
    
3. Desk
    
4. Workshop
    
5. Inbox
    
6. Task Board
    
7. Idea Bank
    
8. Rest Room
    
9. Meeting Room
    
10. Security Office
    
11. Manager's Office
    

각 공간의 **개념적 역할은 확정**되어 있다.

하지만 다음은 아직 결정하지 않는다.

- 실제 디렉터리인지
    
- 데이터베이스 개념인지
    
- UI 화면인지
    
- 런타임 상태인지
    
- 여러 구현을 조합하는지
    

**Implementation representation: Open**

---

# 5. Core System Pillars

Nidus의 기술 설계는 다음 네 축을 중심으로 진행한다.

## 5.1 Context

AI에게 현재 무엇을 보여줄 것인가.

Library 전체와 현재 작업에 필요한 Desk를 어떻게 연결할 것인가.

**Status: Confirmed concept / Open design**

## 5.2 Coordination

AI Employee와 Task를 어떻게 조직할 것인가.

중복, 충돌, 의존성을 어떻게 관리할 것인가.

**Status: Confirmed concept / Open design**

## 5.3 Attention

언제 인간의 주의를 요청할 것인가.

자율성을 유지하면서 불필요한 승인 요청을 어떻게 줄일 것인가.

**Status: Confirmed concept / Open design**

## 5.4 Permission

AI가 무엇을 읽고, 수정하고, 실행하고, 외부로 전송할 수 있는지 어떻게 통제할 것인가.

**Status: Confirmed concept / Open design**

---

# 6. Knowledge Model

## 6.1 Library

사용자의 전체 장기 지식 공간.

개인 지식, 프로젝트 자료, 과거 기록, Obsidian Vault 등을 포함한다.

**Status: Confirmed**

## 6.2 Personal RAG

Personal RAG는 별도의 제품이나 독립적인 상위 시스템이 아니다.

AI Employee가 Library에서 필요한 정보를 찾기 위한 내부 능력이다.

**Status: Confirmed**

## 6.3 Desk

현재 Task 수행에 필요한 정보만 가져오는 작업 Context 공간이다.

원칙:

**Library = 전체 지식**

**Desk = 지금 필요한 지식**

**Status: Confirmed**

---

# 7. Human × AI Operating Model

기본 구조:

Human Manager  
→ Goal  
→ Projects  
→ Tasks  
→ AI Employees  
→ Results  
→ Library

AI는 목표와 프로젝트를 보고 필요한 Task를 스스로 생성할 수 있다.

인간은 언제든 Task를 다음과 같이 제어할 수 있다.

- 추가
    
- 수정
    
- 중단
    
- 우선순위 변경
    
- 방향 변경
    

**Status: Confirmed**

---

# 8. Thought Lifecycle

생각은 바로 Task가 되지 않는다.

기본 Lifecycle:

Thought  
→ Idea Bank  
→ Discussion  
→ Incubation  
→ Decision  
→ Task / Project  
→ Library

Idea Bank는 아직 확정되지 않은 생각을 위한 공간이다.

Library는 검토를 거쳐 살아남은 지식과 기록을 저장한다.

**Status: Confirmed**

---

# 9. MVP Shape

이 섹션에서는 Nidus의 첫 번째 구현 버전이 무엇을 검증해야 하는지를 정의한다.

## 9.1 MVP Hypothesis

**Status: Open**

결정 필요:

- 첫 MVP가 검증하려는 핵심 가설
    
- MVP의 사용자 경험 범위
    
- MVP에서 필요한 최소 AI Employee 수
    
- Multi-Agent 포함 여부
    
- Personal RAG 구현 범위
    
- AI-generated Task 포함 여부
    
- Human intervention 수준
    

## 9.2 Timebox

**Status: Open**

## 9.3 In Scope

**Status: Open**

## 9.4 Out of Scope

**Status: Open**

---

# 10. Observable Product Behavior

MVP 범위가 결정된 이후 작성한다.

각 요구사항은 가능한 경우 다음 형태로 관리한다.

### FR-XX — Functional Requirement

- 상태:
    
- 설명:
    
- Trigger:
    
- Expected behavior:
    

### AC-XX — Acceptance Criteria

사용자가 관찰하거나 테스트할 수 있는 결과로 작성한다.

---

# 11. Primary User Flows

아직 정의하지 않는다.

후보 Flow:

- Goal 생성
    
- Project 생성
    
- Task 생성
    
- Agent 실행
    
- Library 탐색
    
- Desk 구성
    
- 결과 생성
    
- Human intervention
    
- 결과 저장
    

**Status: Open**

---

# 12. System Architecture

제품 행동이 확정된 이후 설계한다.

## 12.1 System Boundary

**Status: Open**

## 12.2 Runtime Units

**Status: Open**

## 12.3 Agent Runtime

**Status: Open**

## 12.4 Context Architecture

**Status: Open**

## 12.5 Coordination Architecture

**Status: Open**

## 12.6 Attention Architecture

**Status: Open**

## 12.7 Permission Architecture

**Status: Open**

## 12.8 Persistence

**Status: Open**

## 12.9 External Systems

**Status: Open**

---

# 13. Domain & State Model

구현 아키텍처를 결정하면서 정의한다.

후보 Domain은 존재할 수 있으나 현재는 확정하지 않는다.

예:

- Project
    
- Employee
    
- Task
    
- Thought
    
- Decision
    
- Knowledge
    
- Execution
    
- Artifact
    
- Event
    

**Status: Open**

---

# 14. Critical Uncertainties

설계 과정에서 발견되는 기술적·제품적 불확실성을 기록한다.

각 항목:

- Uncertainty
    
- Impact
    
- Likelihood
    
- Validation method
    
- Result
    
- Decision
    

현재:

**None registered**

---

# 15. Architecture Decisions

되돌리기 어렵거나 시스템 구조에 큰 영향을 주는 결정만 기록한다.

형식:

### ADR-XX — Decision title

**Status:** Proposed / Accepted / Superseded

**Context**

**Options**

**Decision**

**Consequences**

현재:

**None**

---

# 16. Implementation Strategy

구현은 Horizontal Layer가 아니라 Vertical Slice 단위로 진행한다.

각 Slice는 실제로 관찰 가능한 End-to-End 동작을 만들어야 한다.

## Slice 1

**Status: Not defined**

### Covers

### Expected behavior

### Components

### Verification

### Done when

### Excluded

---

# 17. Implementation Gate

실제 구현을 시작하기 전에 다음 조건을 확인한다.

- MVP 문제와 목적이 명확하다.
    
- 사용자와 핵심 결과가 명확하다.
    
- Timebox가 정해졌다.
    
- In Scope / Out of Scope가 명확하다.
    
- 주요 Flow가 정의되었다.
    
- Acceptance Criteria가 테스트 가능하다.
    
- System Boundary가 정의되었다.
    
- 주요 Runtime 책임이 정의되었다.
    
- 데이터 소유권이 명확하다.
    
- 핵심 위험이 검증되었거나 의식적으로 수용되었다.
    
- Slice 1의 완료 조건이 명확하다.
    
- Slice 1을 바꿀 만한 Open Decision이 남아 있지 않다.
    

---

# 18. Current Decision Queue

현재 가장 먼저 결정해야 할 문제를 순서대로 관리한다.

### D-01 — MVP가 검증해야 할 핵심 가설

**Status: Open**

### D-02 — MVP 범위

**Status: Blocked by D-01**

### D-03 — MVP Timebox

**Status: Open**

### D-04 — Primary User Flow

**Status: Blocked by D-01 / D-02**

### D-05 — System Boundary

**Status: Later**

### D-06 — Core Architecture

**Status: Later**

---

# 19. Change Candidates

설계 또는 구현 중 발견되었지만 아직 승인되지 않은 아이디어를 기록한다.

현재:

**None**

---

# 20. Current Phase

**Phase: Shape**

현재 목표:

> Nidus 전체 비전을 구현하려 하지 않고, 첫 번째 작동 가능한 Nidus가 무엇을 검증해야 하는지를 정의한다.

현재 Blocking Decision:

> **D-01 — Nidus MVP가 검증해야 할 가장 중요한 가설은 무엇인가?**