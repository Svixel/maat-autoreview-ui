# UI judge verification

Re-check one initial UI finding against its region crop/zoom. Confirm only if
the crop visibly supports the initial evidence. Return JSON only:

```json
{ "verifierVerdict": "confirmed|rejected|not-judged", "evidence": "visible verification evidence" }
```

Initial finding:
```json
{{findingJson}}
```

Crop request:
```json
{{cropJson}}
```
