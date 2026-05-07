module.exports = {
  loginButton: 'button:has-text("Log in")',
  gameloftLoginButton: 'button:has-text("Sign in with Gameloft account")',
  emailInput: 'input[type="email"]',
  continueButton: 'text="Continue"',
  visibleInput: 'input:not([type="hidden"])',
  otpSubmitButton: 'button:has-text("Submit"), text="Submit", div:has-text("Submit")',
  freeRewardLabel: 'div:text-is("Free")',
  rewardImage: 'img[src*="webstore_"], img[src]',
  orderSummary: 'text="ORDER SUMMARY", text="Order Summary"',
  claimButton: 'button:has-text("Claim"), [role="button"]:has-text("Claim"), div:text-is("Claim"), text="Claim"'
};
