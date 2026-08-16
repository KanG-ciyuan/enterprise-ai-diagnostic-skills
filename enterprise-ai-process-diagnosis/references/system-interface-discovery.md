# System And Interface Discovery

Technical design begins with current-state facts, not product imagination. Complete only the fields that affect the proposed process; do not perform an unlimited infrastructure audit.

## Evidence Status

Every finding must be one of:

- `已确认`: supported by current documentation, authorized inspection, test response, export sample, or system owner confirmation with concrete details;
- `仅口述`: reported by one or more people but not verified in the system;
- `未知`: not yet checked;
- `不可用`: confirmed absent, prohibited, unsupported, or inaccessible.

Do not convert `仅口述` into `已确认`. A product name or screenshot does not prove an interface exists.

## Minimum Discovery Domains

| Domain | What to establish | Minimum useful evidence | Ask or obtain from |
|---|---|---|---|
| System boundary | system, purpose, owner, process nodes | current system list and owner | process owner, IT |
| Access path | official API, webhook, database view, export/import, authorized UI, manual only | interface docs, sample export, controlled test | system admin, vendor |
| Direction | read, write, event receive, file import | allowed operations and scope | system owner, security |
| Authentication | auth type, service account, role, token lifecycle | redacted permission description or test result | admin, security |
| Environment | sandbox/test availability and data separation | test environment confirmation | IT, vendor |
| Data contract | identifiers, fields, formats, timestamps, nulls, code lists | desensitized sample and field dictionary | data owner |
| Operating load | volume, frequency, latency, peak, file size | one representative period | operator, logs |
| Reliability | rate limits, retry, idempotency, ordering, duplicate behavior | interface documentation or controlled test | IT, vendor |
| Security | classification, residency, retention, encryption, audit | internal policy and approval owner | security, legal where applicable |
| Deployment | cloud/on-prem/hybrid, network zones, egress, approved runtimes | architecture constraint note | IT architecture |
| Operations | monitoring, alerts, kill switch, incident owner | operating owner and escalation path | system owner |
| Commercial | licenses, usage limits, budget owner, vendor support | license/contract boundary | procurement, sponsor |

## Feasibility Rules

- Official supported interfaces are preferred over UI automation.
- Structured file exchange is a valid first route when APIs are unavailable but exports are authorized and repeatable.
- RPA is conditional on an authorized, sufficiently stable UI and a named maintenance owner.
- Production writes require a separate approval boundary from read-only access.
- Sensitive data must not be sent to a model until deployment, retention, and authorization are confirmed.
- Missing system evidence does not block a file-based offline shadow pilot, but it does block claims of production integration readiness.

## Decision-Changing Evidence Requests

Request evidence in this order:

1. one desensitized input/output sample and the stable business identifier;
2. supported access paths and read/write permissions;
3. sandbox or safe test method;
4. data classification and deployment constraints;
5. volume, latency, error, retry, and audit requirements;
6. named business, system, security, and maintenance owners.

Stop when the next answer would not change feasibility, architecture branch, risk, or the pilot.

