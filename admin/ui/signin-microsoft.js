// The redirect URI registered with Microsoft. Kept to one job: finish the flow
// ms-signin.js started, then leave. A file, not an inline script, so it keeps
// working when the console's Content-Security-Policy is enforced.

import { complete } from "./ms-signin.js";

complete()
  .then((next) => location.replace(next))
  .catch((e) => {
    document.getElementById("msg").hidden = true;
    const el = document.getElementById("msErr");
    el.textContent = e.message;
    el.hidden = false;
    document.getElementById("again").hidden = false;
  });
