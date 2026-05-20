# Basic Code Review Checks

This check runs foundational static analysis and ensures best practices are followed across the codebase before merging.

## 🎯 Focus Areas
*   **Security:** All user inputs must be sanitized and validated against expected types. Check for potential SQL injection vectors, especially in `sql/` files or database interaction layers (`models/*`).
*   **Error Handling:** Every function that interacts with external services (DB, API calls) must utilize proper `try...catch` blocks or defined error handlers (`middlewares/errorHandler.js`) to prevent crashes.
*   **Consistency:** Ensure naming conventions are followed across controllers, models, and routes.

## ✅ Checks
### 1. Input Validation Check
> **Rule:** All incoming request bodies (especially in `controllers/*` and `routes/*`) must be explicitly validated against a schema before proceeding with business logic.
> **Example Failure:** If a required field like `userId` is missing, the middleware should immediately return a 400 Bad Request status, not proceed to database query.

### 2. Database Interaction Check
> **Rule:** Direct string interpolation for SQL queries is forbidden. Use parameterized queries or ORM methods exclusively when interacting with the database (`sql/*`).
> **Failure:** Detected usage of `mysql.query("SELECT * FROM users WHERE id = " + userId)` should be flagged and rewritten to use placeholders: `mysql.query("SELECT * FROM users WHERE id = ?", [userId])`.

### 3. Deprecated Code Check
> **Rule:** Any module using deprecated libraries or outdated patterns (e.g., old callback style) must be updated.

## 💡 Action Required
Please review the changes made in this PR and confirm that all code adheres to these basic quality standards. If any rule is violated, please fix it before merging.

