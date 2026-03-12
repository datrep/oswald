const form = document.getElementById("editImageForm");
const loadingMessage = document.getElementById("loadingMessage");
const messageDiv = document.getElementById("message");

const imageIdInput = document.getElementById("imageId");
const titleInput = document.getElementById("editTitle");

const apiBaseUrl = "http://localhost:3000";

function getImageIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("id");
}

async function fetchImageData(imageId) {
  try {
    const res = await fetch(`${apiBaseUrl}/images/${imageId}`);
    if (!res.ok) throw new Error("Failed to fetch image.");
    return await res.json();
  } catch (err) {
    loadingMessage.textContent = "Error loading image.";
    messageDiv.textContent = err.message;
  }
}

function populateForm(image) {
  imageIdInput.value = image.id;
  titleInput.value = image.title;
  loadingMessage.style.display = "none";
  form.style.display = "block";
}

const imageId = getImageIdFromUrl();
if (imageId) {
  fetchImageData(imageId).then(image => {
    if (image) populateForm(image);
  });
} else {
  loadingMessage.textContent = "No image ID provided in URL.";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const updated = {
    title: titleInput.value
  };

  try {
    const res = await fetch(`${apiBaseUrl}/images/${imageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated)
    });

    if (!res.ok) throw new Error(`Failed to update. (${res.status})`);

    messageDiv.textContent = "Image updated successfully.";
    messageDiv.style.color = "green";

    setTimeout(() => {
      window.location.href = "index.html";
    }, 1500);
  } catch (err) {
    messageDiv.textContent = err.message;
    messageDiv.style.color = "red";
  }
});

