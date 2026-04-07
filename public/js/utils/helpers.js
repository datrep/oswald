// Place for utility/helper JS functions shared across pages


function showTime() {
  let date = new Date();
  
  // Format options: 24h clock and YYYY/MM/DD
  let options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false // This forces 24-hour format
  };

  // Generate the string (en-GB uses DD/MM/YYYY, so we manually join for YYYY/MM/DD)
  let year = date.getFullYear();
  let month = String(date.getMonth() + 1).padStart(2, '0');
  let day = String(date.getDate()).padStart(2, '0');
  let time = date.toLocaleTimeString('en-GB', { hour12: false });

  let fullDisplay = `${year}/${month}/${day} ${time}`;
  
  document.getElementById("myClock").innerText = fullDisplay;
  setTimeout(showTime, 1000);
}
showTime();
