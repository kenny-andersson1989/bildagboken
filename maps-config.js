// Tokens för Apple Maps (MapKit JS). Varje token är låst till en adress och fungerar inte på andra,
// så de får ligga öppet här, precis som Firebase-inställningarna. Rätt token väljs efter adressen appen körs på.
const TOKENS = {
  "bildagboken.com": "eyJraWQiOiJGQ1U1NjlLUks2IiwidHlwIjoiSldUIiwiYWxnIjoiRVMyNTYifQ.eyJpc3MiOiJUTVdROVhBNzdEIiwiaWF0IjoxNzk0NTcxNTMwLCJvcmlnaW4iOiJiaWxkYWdib2tlbi5jb20iLCJzY29wZSI6Im1hcGtpdF9qcyJ9.54MV5v5X-J0tChBp5D5VZ2r-Jm1lkf6wenpf84YGskz1YSpIm2gMirUTKuTUxeMygZyTTrCE478NX2_Edl-Adg",
  "kenny-andersson1989.github.io": "eyJraWQiOiJBMks2WTJTQ05GIiwidHlwIjoiSldUIiwiYWxnIjoiRVMyNTYifQ.eyJpc3MiOiJUTVdROVhBNzdEIiwiaWF0IjoxNzk0MzgxOTYwLCJvcmlnaW4iOiJrZW5ueS1hbmRlcnNzb24xOTg5LmdpdGh1Yi5pbyIsInNjb3BlIjoibWFwa2l0X2pzIn0.-P0Snbud0Mi4YPvL1RCbbuNk73HZWu8GFdrhmJqDn79kpTK433xmwUFRi3i8xUoW3dCo-QWzM07d0sSLCuLJ4g",
};
export const MAPKIT_TOKEN = TOKENS[location.hostname.replace(/^www\./, "")] || TOKENS["kenny-andersson1989.github.io"];
