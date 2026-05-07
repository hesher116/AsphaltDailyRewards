module.exports = {
  loginButton: 'button:has-text("Log in")',
  gameloftLoginButton: 'button:has-text("Sign in with Gameloft account")',
  emailInput: 'input[type="email"]',
  continueButton: 'text="Continue"',
  visibleInput: 'input:not([type="hidden"])',
  otpSubmitButton: 'button:has-text("Submit"), text="Submit", div:has-text("Submit")',
  rewardImage: 'img[src*="webstore_"], img[src]',
  orderSummary: ':text("ORDER SUMMARY"), :text("Order Summary")',
  claimButton: 'button:text-is("Claim"), [role="button"]:text-is("Claim"), :text-is("Claim")'
};
