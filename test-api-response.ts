import "dotenv/config";

async function testGetUserConcerts() {
  const SERVER_URL = process.env.PARSE_SERVER_URL || "http://localhost:3000/parse";
  const APP_ID = process.env.PARSE_APP_ID || "gigz-app";

  // Use your session token from the production logs
  const sessionToken = "r:3d99f5f83e3c039fb95c09df967e8cea"; // Replace with actual token

  try {
    console.log("Testing getUserConcerts API...\n");

    const response = await fetch(`${SERVER_URL}/functions/getUserConcerts`, {
      method: "POST",
      headers: {
        "X-Parse-Application-Id": APP_ID,
        "X-Parse-Session-Token": sessionToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        limit: 5,
        skip: 0
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("API Error:", error);
      return;
    }

    const data = await response.json();
    console.log("Full response:", JSON.stringify(data, null, 2));

    if (data.result?.results?.[0]) {
      const firstConcert = data.result.results[0];
      console.log("\n=== First Concert Details ===");
      console.log("UserConcert ID:", firstConcert.objectId);
      console.log("Concert Date:", firstConcert.concert?.concert_date);
      console.log("Concert Date Type:", typeof firstConcert.concert?.concert_date);
      console.log("Artist:", firstConcert.concert?.artist?.name);
      console.log("Venue:", firstConcert.concert?.venue?.name);

      // Check date format
      if (firstConcert.concert?.concert_date) {
        const dateValue = firstConcert.concert.concert_date;
        const isParseDateFormat = dateValue.__type === "Date";
        console.log("\n=== Date Format Check ===");
        console.log("Is Parse Date format:", isParseDateFormat);
        console.log("Date value:", dateValue);
      }
    }

  } catch (error) {
    console.error("Failed to test API:", error);
  }
}

testGetUserConcerts();