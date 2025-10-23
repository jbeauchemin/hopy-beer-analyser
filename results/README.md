# Résultats de recherche

Ce dossier contient les résultats sauvegardés des recherches de bières.

## Format des fichiers

Les fichiers sont nommés: `YYYY-MM-DDTHH-MM-SS_producer-product.json`

Exemple: `2025-01-23T14-30-45_messorem-naufrage-oublie.json`

## Structure JSON

```json
{
  "timestamp": "2025-01-23T14:30:45.123Z",
  "query": {
    "producer": "Messorem",
    "product": "Naufragé Oublié",
    "combined": "Messorem Naufragé Oublié"
  },
  "results": {
    "veuxtuunebiere": { ... },
    "masoif": { ... },
    "espacehoublon": { ... },
    "untappd": { ... }
  },
  "summary": {
    "sources_found": ["veuxtuunebiere", "espacehoublon", "untappd"],
    "total_sources": 3
  }
}
```

## Utilisation

Pour sauvegarder automatiquement les résultats, utilisez le flag `--save` ou `--json`:

```bash
node analyze_beers.js --producer="Messorem" --product="Naufragé Oublié" --save
```

Les fichiers JSON sont exclus du contrôle de version (voir .gitignore).
