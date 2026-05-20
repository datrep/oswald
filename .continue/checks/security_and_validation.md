# Security & Input Validation Checks

This check ensures that the application handles all user input securely and validates data integrity at multiple layers.

## 🔒 Focus Areas
*   **Injection Prevention:** The single most critical area is preventing SQL Injection (SQLi). All database interactions must use prepared statements or ORM methods exclusively.
*   **Schema Validation:** Every incoming request parameter, whether in `routes/*` or consumed by `controllers/*`, must pass through an explicit validation layer that checks type, required status, and format before any business logic executes.
*   **Authorization Check:** The authentication middleware (`middlewares/auth.js`) should be utilized consistently across all sensitive routes to ensure the requester has the minimum necessary permissions (Principle of Least Privilege).

## ⚠️ Checks
### 1. SQL Injection Prevention
> **Rule:** Never construct SQL queries by concatenating user input directly into the string. 
> **Failure Example:** If we see `SELECT * FROM users WHERE email = '" + userInputEmail + "'`, this must be replaced with a parameterized query pattern, such as `SELECT * FROM users WHERE email = ?` and passing the user input as an array parameter.

### 2. Data Schema Validation
> **Rule:** Middleware should enforce data schema checks (e.g., using Joi or Yup) for request body payloads in all API endpoints. The validation failure must be caught, logged, and returned to the client with a clear 400 error code.

### 3. Sensitive Data Exposure
> **Rule:** Check that any logging mechanism (e.g., `utils/logger.js`) redacts or masks sensitive PII (Personally Identifiable Information) such as passwords, API keys, or full credit card numbers before logging them to the console or database.

## 💡 Action Required
Please verify all data paths and query builders across the codebase adhere strictly to these security guidelines.