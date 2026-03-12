document.getElementById("createImageForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const form = e.target;
  const formData = new FormData(form);

  try {
    const response = await fetch("/images", {
      method: "POST",
      body: formData, // ✅ send FormData directly
      // ❌ Do not set headers here — the browser will handle it
    });

    const result = await response.json(); // This assumes your server returns JSON

    if (!response.ok) {
      throw new Error(result.message || "Failed to create image");
    }

    messageDiv.textContent = "✅ Image created successfully!";
    messageDiv.style.color = "green";
    setTimeout(() => window.location.href = "index.html", 1000);
  } catch (err) {
    console.error(err);
    messageDiv.textContent = "Error: " + err.message;
    messageDiv.style.color = "red";
  }
})  
