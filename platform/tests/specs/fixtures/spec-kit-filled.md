# Feature Specification: Filter orders by status

**Feature Branch**: `003-order-status-filter`
**Status**: Draft

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Filter the order list (Priority: P1)

Sales staff filter the order list by status.

**Why this priority**: Staff look for open orders every morning.

**Independent Test**: Can be fully tested by choosing a status on the order list.

**Acceptance Scenarios**:

1. **Given** orders with the statuses 受付 and 出荷済, **When** the user chooses 受付, **Then** only received orders are shown
2. **Given** a status filter is set, **When** the user clears it, **Then** every order is shown

---

### User Story 2 - Keep the filter in the URL (Priority: P2)

**Why this priority**: Staff share links.

**Independent Test**: Open a link with a status.

**Acceptance Scenarios**:

1. **Given** the URL holds `?status=shipped`, **When** the page opens, **Then** the filter shows 出荷済

---

### Edge Cases

- What happens when no order has the chosen status?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST filter orders by status
- **FR-002**: System MUST keep the filter in the URL

## Success Criteria *(mandatory)*

- **SC-001**: Staff find open orders in under 10 seconds
