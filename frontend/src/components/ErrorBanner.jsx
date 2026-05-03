import React from 'react';

export default function ErrorBanner({message}) {
    return (
        <p style={{color: 'red', marginTop: '1rem', textAlign: 'center'}}>
            <span role="img" aria-label="warning">🚨</span> {message}
        </p>
    );
}
