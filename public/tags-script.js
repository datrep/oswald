async function fetchAllTags() {
  try {
    const response = await fetch('/tags'); // Assumes your backend returns all tags
    const tags = await response.json();

    // Sort alphabetically by name
    tags.sort((a, b) => a.name.localeCompare(b.name));

    const listContainer = document.getElementById("tag-list");

    if (tags.length === 0) {
      listContainer.innerHTML = "<p>No tags found.</p>";
      return;
    }

    tags.forEach(tag => {
      const link = document.createElement("a");
      link.href = `/posts.html?tags=${encodeURIComponent(tag.name)}`;
      link.textContent = tag.name;
      link.style.display = "block"; // One per line
      listContainer.appendChild(link);
    });

  } catch (err) {
    console.error("Error fetching tags:", err);
    document.getElementById("tag-list").textContent = "Failed to load tags.";
  }
}

fetchAllTags();

