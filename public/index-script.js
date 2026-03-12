//this thing took me 4 hours to troubleshoot hthinking whyy the images werent dnamically loading in 


// Fetch images from backend and render gallery.
// Optionally filter images by tags (string or null).
async function fetchImages(tags = null) {
  try {
    let url = '/images';
    if (tags && tags.trim() !== '') {
      url += `?tags=${encodeURIComponent(tags.trim())}`;
    }
    console.log("Fetching images from:", url);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch images: ${response.statusText}`);

    const images = await response.json();
    console.log("Images fetched:", images);

    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '';

    if (images.length === 0) {
      gallery.innerHTML = '<p>No images found matching your search.</p>';
      return;
    }

    images.forEach(image => {
      const card = document.createElement('div');
      card.className = 'image-card';

      const date = new Date(image.dateAdded);
      const formattedDate = date.toLocaleString("en-US", {
        dateStyle: "long",
        timeStyle: "short",
      });

      card.innerHTML = `
        <div class="post-preview-container" style="cursor:pointer;">
          <img src="${image.filePath}" alt="${image.title}" />
        </div>
        <div class="image-info">
          <h3 class="title">${image.title}</h3>
          <p class="filename"><strong>Filename:</strong> ${image.filename}</p>
          <p class="date"><strong>Uploaded:</strong> ${formattedDate}</p>
        </div>
      `;

      card.querySelector(".post-preview-container").addEventListener("click", () => {
        window.location.href = `view.html?id=${image.id}`;
      });

      gallery.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load images:', err);
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<p>Error loading images. Please try again later.</p>';
  }
}

async function fetchAndDisplayTags() {
  try {
    const res = await fetch("/tags");
    if (!res.ok) throw new Error(`Failed to fetch tags: ${res.statusText}`);

    const tags = await res.json();

    const tagContainer = document.getElementById("image-menu");
    tagContainer.innerHTML = ""; // clear existing content

    // Add a "Create New Image" button/link styled like tags container
    const createWrapper = document.createElement("div");
    createWrapper.style.border = "1px solid rgb(204, 204, 204)";
    createWrapper.style.padding = "6px";
    createWrapper.style.marginTop = "4px";
    createWrapper.style.borderRadius = "5px";
    createWrapper.style.display = "inline-block";

    const createLink = document.createElement("a");
    createLink.href = "create-image.html";
    createLink.textContent = " Create New Image";
    createLink.style.textDecoration = "none";
    createLink.style.color = "#007bff";
    createLink.style.fontWeight = "bold";
    createLink.style.cursor = "pointer";

createWrapper.appendChild(createLink);
tagContainer.appendChild(createWrapper);

    // Sort tags by popularity descending
    tags.sort((a, b) => b.count - a.count);

    // Append each tag after the create link
    tags.forEach(tag => {
      const wrapper = document.createElement("div");
      wrapper.style.border = "1px solid rgb(204, 204, 204)";
      wrapper.style.padding = "6px";
      wrapper.style.marginTop = "4px";
      wrapper.style.borderRadius = "5px";

      const tagLink = document.createElement("a");
      tagLink.href = "http://localhost:3000/tags";
      tagLink.style.textDecoration = "none";
      tagLink.style.color = "#007bff";
      tagLink.textContent = tag.name;

      wrapper.appendChild(tagLink);
      tagContainer.appendChild(wrapper);
    });

  } catch (error) {
    console.error("Failed to load tags:", error);
  }
}



// Setup event listeners on search input and button.
// Supports click and pressing Enter to trigger search.
function setupSearchHandler() {
  const searchBtn = document.getElementById("search-button");
  const searchInput = document.getElementById("search-input");

  if (!searchBtn || !searchInput) {
    console.warn("Search button or input not found in DOM.");
    return;
  }

  // On button click: redirect to filtered index page
  searchBtn.addEventListener("click", () => {
    const query = searchInput.value.trim();
    if (query) {
      window.location.href = `index.html?tags=${encodeURIComponent(query)}`;
    } else {
      window.location.href = "index.html";
    }
  });

  // On Enter key press in search input: trigger search
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const query = searchInput.value.trim();
      if (query) {
        window.location.href = `index.html?tags=${encodeURIComponent(query)}`;
      }
    }
  });
}

// On page load, parse ?tags= query parameter,
// prefill the search input, and load images accordingly.
function prefillSearchAndFilter() {
  const params = new URLSearchParams(window.location.search);
  const tagFilter = params.get("tags");

  if (tagFilter) {
    const searchInput = document.getElementById("search-input");
    if (searchInput) searchInput.value = tagFilter;
  }

  fetchImages(tagFilter);
}

// Initialize all functionality on DOMContentLoaded event.
document.addEventListener("DOMContentLoaded", () => {
  fetchAndDisplayTags();
  setupSearchHandler();
  prefillSearchAndFilter();
});
