const app = require("./app.json");

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = () => {
  const projectId = process.env.EAS_PROJECT_ID?.trim();
  const appleTeamId = process.env.APPLE_TEAM_ID?.trim();
  if (projectId && !uuid.test(projectId)) {
    throw new Error("EAS_PROJECT_ID must be the EAS project UUID for @djerayane/stash-capture");
  }
  if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
    throw new Error("APPLE_TEAM_ID must be the 10-character Apple Developer team identifier");
  }
  return {
    ...app.expo,
    ...(appleTeamId ? { ios: { ...app.expo.ios, appleTeamId } } : {}),
    ...(projectId ? { extra: { ...app.expo.extra, eas: { projectId } } } : {})
  };
};
