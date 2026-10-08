# Pilot - Epic Breakdown

## Overview

The order list gets pagination.

## Epic 1: Order list

### Story 1.1: Paginate the order API

As a sales staff member,
I want the order list in pages,
So that the screen stays fast.

**Acceptance Criteria:**

**Given** 120 orders
**When** the client asks for page 2 with 50 per page
**Then** orders 51 to 100 are returned
**And** the response holds the total count

**Given** a page past the last one
**When** the client asks for it
**Then** an empty list is returned

### Story 1.2: Paginate the order screen

As a sales staff member,
I want page buttons,
So that I can move between pages.

**Acceptance Criteria:**

**Given** more than 50 orders
**When** the order screen opens
**Then** page buttons are shown
