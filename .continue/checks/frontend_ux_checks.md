# Frontend & UX Checks

This check ensures that the user interface provides a robust and predictable experience, even when data is loading, empty, or an error occurs.

## 🎨 Focus Areas
*   **Loading States:** All components fetching remote data (e.g., in `public/js/*`) must display an explicit skeleton loader component while data is being fetched.\n*   **Empty States:** When a search, filter, or list returns zero results, the UI should not show an empty container. Instead, it must display a helpful 'No results found' message with guidance on how to fix the issue.
*   **Error Visibility:** Client-side errors (e.g., network timeouts, API failures) must be displayed to the user in a non-intrusive but clear manner, avoiding generic browser error messages.

## 🧪 Checks
### 1. Skeleton Loading Implementation\n> **Rule:** For data fetching mechanisms using `fetch` or Axios within components (like those found in `public/js/pages/*`), ensure that a visual placeholder element is rendered immediately upon component mounting and before the data resolves.

### 2. Empty Result Handling\n> **Rule:** Data rendering loops must include logic to check for an empty array (`if (!results || results.length === 0)`) and render a dedicated, descriptive component instead of simply showing nothing.

## 💡 Action Required
Please review all client-side data fetching paths and ensure that robust skeleton/empty state components are in place throughout the application.