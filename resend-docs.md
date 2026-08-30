1. List Received Emails

```
import { Resend } from 'resend';

const resend = new Resend('re_xxxxxxxxx');

const { data, error } = await resend.emails.receiving.list();
```

2. Retrieve Received Email

```
import { Resend } from 'resend';

const resend = new Resend('re_xxxxxxxxx');

const { data, error } = await resend.emails.receiving.get('5e4d5e4d-5e4d-5e4d-5e4d-5e4d5e4d5e4d');
```
