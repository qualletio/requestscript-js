# Resource Improvements

Improve how Resources are called. When they are invoked, they return the function return value embedded in an object. Call the field that contains it `value`.

This object also has an `error` field. The `error` field is an object with one property `message` which is a string. The `ResourceInvoker` will return this object instead of the direct `value`.

If a resource function has a return value and no error, it will look like this:

```
{
    value: 123,
    error: null,
}
```

If a resource function has a return value but returns an error, it will look like this:

```
{
    value: null,
    error: {
        message: "Example Message",
    },
}
```

The user can then check for the presence of the `error` object within RequestScript:

```
{
    request MyRequest {

        const weather: com.example.Weather

        const temperature = weather.temperature(city: "Oslo")

        if (temperature.error != null) {
            return temperature.error.message
        }
    }
}
```
