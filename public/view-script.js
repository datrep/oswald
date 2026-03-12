async function fetchImageAndTags() {
  const params = new URLSearchParams(window.location.search);
  const imageId = params.get("id");

  if (!imageId) {
    document.getElementById("image-menu").textContent = "No image ID provided.";
    return;
  }

  try {
    // Fetch image details
    const response = await fetch(`/images/${imageId}`);
    if (!response.ok) throw new Error("Image not found");
    const image = await response.json();

    const uploadedDate = new Date(image.dateAdded);
    const formattedDate = uploadedDate.toLocaleString(undefined, {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

    // Fill in image details
    document.getElementById("image-title").textContent = image.title;
    document.getElementById("image-description").textContent = image.description || "No description";
    document.getElementById("image-uploader").textContent = image.uploader || "Administrator";
    document.getElementById("image-date").textContent = formattedDate;
    document.getElementById("image-size").textContent = (image.width && image.height)
      ? `${image.width}x${image.height}`
      : "Unknown";
    document.getElementById("image-filesize").textContent = image.filesize
      ? `${(image.filesize / 1024).toFixed(1)} KB`
      : "Unknown";
    document.getElementById("image-status").textContent = image.status || "Pending";

    // Display the image
    document.getElementById("content").innerHTML = `
      <img src="${image.filePath}" alt="${image.title}" />
    `;

    // Setup Edit button
    document.getElementById("edit-button").addEventListener("click", () => {
      window.location.href = `/edit-image.html?id=${imageId}`;
    });

    // Setup Delete button
    document.getElementById("delete-button").addEventListener("click", async () => {
      if (!confirm("Are you sure you want to delete this image?")) return;

      try {
        const deleteResponse = await fetch(`/images/${imageId}`, { method: "DELETE" });
        if (!deleteResponse.ok) throw new Error("Delete failed");

        alert("Image deleted successfully.");
        window.location.href = "/";
      } catch (error) {
        alert("Error deleting image: " + error.message);
      }
    });

    // Fetch tags for this image
    try {
      const tagResponse = await fetch(`/tags/${imageId}`);
      const tags = await tagResponse.json();

      const tagContainer = document.getElementById("image-tags");
      tagContainer.innerHTML = "<strong>Tags:</strong>";

      if (tags.length === 0) {
        const noTags = document.createElement("div");
        noTags.textContent = "No tags found.";
        tagContainer.appendChild(noTags);
      } else {
        tags.forEach(tag => {
            const tagRow = document.createElement("div");
            tagRow.style.border = "1px solid #ccc";
            tagRow.style.padding = "6px";
            tagRow.style.marginTop = "4px";
            tagRow.style.borderRadius = "5px";
            tagRow.innerHTML = `<a href="/tags?name=${encodeURIComponent(tag.name)}" style="text-decoration: none; color: #007bff;">${tag.name}</a>`;
            tagContainer.appendChild(tagRow);
        });
      }
    } catch (tagError) {
      console.error("Error fetching tags:", tagError);
    }

  } catch (error) {
    document.getElementById("image-menu").textContent = "Error fetching image: " + error.message;
  }
}

fetchImageAndTags();
