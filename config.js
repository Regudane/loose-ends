/*
  The app's Microsoft registration (Microsoft Entra ID, "Loose Ends phone app").
  clientId is its Application (client) ID and tenantId the Directory (tenant) ID. Neither is a secret:
  every Microsoft sign-in page shows them. The app signs in with PKCE, so there is no client secret anywhere.
*/
window.LE_CONFIG = {
  clientId: "e87d8d85-f150-4139-9499-35d30b51d24f",
  tenantId: "54c351fc-5d25-42f9-9e27-d831f522613b",
};
